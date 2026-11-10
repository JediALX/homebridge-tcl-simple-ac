/**
 * Vendor-agnostic room temperature input. The plugin never talks to a sensor
 * vendor: Apple Home is the only integration point, so any temperature sensor
 * in the Home app (Hue, HomePod, Aqara, Eve...) can feed it.
 *
 * Flow:
 *   1. SensorPollTrigger pulses the "Sensor poll" switch this plugin exposes.
 *   2. A Home automation "when Sensor poll turns on", converted to a shortcut,
 *      reads each room sensor and POSTs { "readings": { "<room key>": <value> } }
 *      to http://<host>:<port>/temperatures with header x-token: <token>.
 *   3. HomeKitTemperatureReceiver stores the values; each AC reads its room
 *      through a RoomSource.
 *
 * Patterns: Strategy (RoomTemperatureSource), Adapter (RoomSource adapts the
 * receiver to the per-room interface).
 */
import http from 'node:http';
import os from 'node:os';
import { timingSafeEqual } from 'node:crypto';

import type { CompensationLog, RoomTemperatureSource, TemperatureReading } from './setpointCompensation';

export interface ReceiverOptions {
  readonly port: number;
  /** e.g. the NAS LAN IP; undefined listens on all interfaces. */
  readonly bindHost?: string;
  /** Shared secret the shortcut sends as x-token. */
  readonly token: string;
  /** Room keys the config maps to devices. Others are reported once and ignored. */
  readonly rooms: readonly string[];
  /** Log every push at info level. Otherwise only the first push after startup is. */
  readonly logEveryPush?: boolean;
}

const MAX_BODY_BYTES = 8 * 1024;

export class HomeKitTemperatureReceiver {
  private readonly readings = new Map<string, TemperatureReading>();
  private readonly reportedUnknown = new Set<string>();
  private server: http.Server | undefined;
  private lastPush: number | undefined;

  constructor(
    private readonly opts: ReceiverOptions,
    private readonly log: CompensationLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves true once listening, false when the port could not be opened (logged, never thrown). */
  start(): Promise<boolean> {
    return new Promise((resolve) => {
      let listening = false;
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', (e: NodeJS.ErrnoException) => {
        this.log.warn(
          `temperature receiver: ${e.code === 'EADDRINUSE' ? `port ${this.opts.port} is already in use` : e.message}. ` +
          'ACs keep their plain targets until it can listen.',
        );
        if (!listening) {
          resolve(false);
        }
      });
      server.listen(this.opts.port, this.opts.bindHost, () => {
        listening = true;
        this.shortcutSetup().forEach((line) => this.log.info(line));
        resolve(true);
      });
      this.server = server;
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  /** The bound port (useful when started on port 0). */
  port(): number | undefined {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : undefined;
  }

  reading(room: string): TemperatureReading | undefined {
    return this.readings.get(room);
  }

  /**
   * Everything to enter in the shortcut's "Get Contents of URL" action. The
   * URL ends at /temperatures; the token and readings go in other fields.
   * The token itself is never logged.
   */
  shortcutSetup(): string[] {
    const urls = this.shortcutUrls();
    const example = this.opts.rooms.map((room) => `"${room}": <Current Temperature>`).join(', ');
    return [
      'temperature receiver ready. In the shortcut\'s "Get Contents of URL" action set:',
      `  URL: ${urls.join(' or ')}${urls.length > 1 ? ' (use the address on your home network)' : ''}`,
      '  Method: POST',
      '  Headers: x-token = the token from the plugin settings',
      `  Request Body: JSON, field "readings" of type Dictionary = { ${example} }`,
    ];
  }

  /**
   * The URL(s) to put in the shortcut's "Get Contents of URL" action: the bind
   * address if one is set, otherwise every external IPv4 address of this host
   * (a NAS or Docker host may list several; the LAN one is the right one).
   */
  shortcutUrls(): string[] {
    const port = this.port() ?? this.opts.port;
    const hosts = this.opts.bindHost
      ? [this.opts.bindHost]
      : Object.values(os.networkInterfaces())
        .flat()
        .filter((a) => a !== undefined && a.family === 'IPv4' && !a.internal)
        .map((a) => a!.address);
    if (hosts.length === 0) {
      hosts.push('<this machine\'s IP>');
    }
    return hosts.map((host) => `http://${host.includes(':') ? `[${host}]` : host}:${port}/temperatures`);
  }

  /** For monitoring: when the Home automation last delivered anything usable. */
  lastPushAt(): number | undefined {
    return this.lastPush;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/temperatures' || !this.tokenMatches(req.headers['x-token'])) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        this.log.warn('temperature push: body too large; dropped');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        this.log.warn(`temperature push: invalid JSON: ${body.slice(0, 200)}`);
        res.writeHead(400).end();
        return;
      }
      const readings = (parsed as { readings?: unknown } | null)?.readings;
      const accepted = readings && typeof readings === 'object' ? this.ingest(readings as Record<string, unknown>) : 0;
      res.writeHead(accepted > 0 ? 204 : 400).end();
    });
  }

  private tokenMatches(header: string | string[] | undefined): boolean {
    if (typeof header !== 'string') {
      return false;
    }
    const a = Buffer.from(header);
    const b = Buffer.from(this.opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private ingest(raw: Record<string, unknown>): number {
    const now = this.now();
    const accepted: string[] = [];
    for (const [room, value] of Object.entries(raw)) {
      if (!this.opts.rooms.includes(room)) {
        if (!this.reportedUnknown.has(room)) {
          this.reportedUnknown.add(room);
          this.log.warn(`temperature push: room key "${room}" is not in the config; ignored (typo in the shortcut?)`);
        }
        continue;
      }
      const celsius = parseCelsius(value);
      if (celsius === undefined) {
        this.log.warn(`temperature push: unreadable value for "${room}": ${JSON.stringify(value)}`);
        continue;
      }
      this.readings.set(room, { celsius, timestamp: now });
      accepted.push(`${room} ${celsius} °C`);
    }
    if (accepted.length > 0) {
      const first = this.lastPush === undefined;
      this.lastPush = now;
      const line = `${first ? 'first temperature push received' : 'temperature push'}: ${accepted.join(', ')}`;
      if (first || this.opts.logEveryPush) {
        this.log.info(line);
      } else {
        this.log.debug(line);
      }
    }
    return accepted.length;
  }
}

/**
 * Shortcuts may send a number, or text such as "21,5 °C" (locale-dependent
 * decimal comma plus unit), depending on how the value enters the dictionary.
 */
export function parseCelsius(value: unknown): number | undefined {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const match = value.replace(',', '.').match(/-?\d+(\.\d+)?/);
    n = match ? parseFloat(match[0]) : NaN;
  } else {
    return undefined;
  }
  // Reject garbage and Fahrenheit-looking values rather than regulate on them.
  return Number.isFinite(n) && n > -20 && n < 50 ? n : undefined;
}

/** Adapter: one room of the receiver as a RoomTemperatureSource. */
export class RoomSource implements RoomTemperatureSource {
  constructor(private readonly receiver: HomeKitTemperatureReceiver, private readonly room: string) {}

  latest(): TemperatureReading | undefined {
    return this.receiver.reading(this.room);
  }
}
