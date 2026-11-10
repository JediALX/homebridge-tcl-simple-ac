import type { CompensationSettings } from './setpointCompensation';

/** The `compensation` block of the platform config, as the user wrote it. */
export interface CompensationConfig {
  enabled?: unknown;
  port?: unknown;
  bindHost?: unknown;
  token?: unknown;
  sensorPollIntervalSeconds?: unknown;
  staleAfterSeconds?: unknown;
  maxOffset?: unknown;
  smoothingMinutes?: unknown;
  minChangeIntervalSeconds?: unknown;
  rooms?: unknown;
  logReadings?: unknown;
}

export const DEFAULT_RECEIVER_PORT = 18581;
export const SENSOR_POLL_PULSE_MS = 3_000;
/** Polls may still show the pre-write target this long after a write. */
const ECHO_GRACE_MS = 90_000;
/** The plugin rounds targets to whole degrees (half degrees are unverified on TCL units). */
const TARGET_STEP = 1;
const MIN_TOKEN_LENGTH = 16;

export type ParsedCompensation =
  /** No block, or enabled is not true: behave exactly as before the feature existed. */
  | { readonly status: 'off' }
  /** Enabled but unusable: warned once; the feature stays off but its accessory is kept. */
  | { readonly status: 'invalid' }
  | {
      readonly status: 'on';
      readonly port: number;
      readonly bindHost: string | undefined;
      readonly token: string;
      readonly sensorPollIntervalMs: number;
      /** Log every temperature push at info level. */
      readonly logReadings: boolean;
      readonly settings: CompensationSettings;
      /** deviceId -> room key */
      readonly rooms: ReadonlyMap<string, string>;
    };

/**
 * Validates the compensation block. Never throws: a bad value logs one
 * warning and switches the feature off, and TCL control carries on.
 */
export function parseCompensationConfig(
  raw: unknown,
  range: { minSetpoint: number; maxSetpoint: number },
  log: { warn(message: string): void },
): ParsedCompensation {
  if (!isRecord(raw) || raw.enabled !== true) {
    return { status: 'off' };
  }
  const c = raw as CompensationConfig;
  const problems: string[] = [];

  const number = (key: keyof CompensationConfig, fallback: number, min: number, max: number, integer = false) => {
    const value = c[key];
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      problems.push(`${key} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
      return fallback;
    }
    return value;
  };

  const port = number('port', DEFAULT_RECEIVER_PORT, 1024, 65535, true);
  const sensorPollIntervalSeconds = number('sensorPollIntervalSeconds', 180, 60, 3600, true);
  const staleAfterSeconds = number('staleAfterSeconds', 600, 120, 7200, true);
  const maxOffset = number('maxOffset', 5, 0.5, 10);
  const smoothingMinutes = number('smoothingMinutes', 10, 0, 120);
  const minChangeIntervalSeconds = number('minChangeIntervalSeconds', 180, 60, 3600, true);

  if (staleAfterSeconds <= sensorPollIntervalSeconds) {
    problems.push('staleAfterSeconds must be longer than sensorPollIntervalSeconds, or every reading would count as stale');
  }

  const token = typeof c.token === 'string' ? c.token.trim() : '';
  if (token.length < MIN_TOKEN_LENGTH) {
    problems.push(`token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  let bindHost: string | undefined;
  if (typeof c.bindHost === 'string') {
    bindHost = c.bindHost.trim() || undefined;
  } else if (c.bindHost !== undefined && c.bindHost !== null) {
    problems.push('bindHost must be an IP address or empty');
  }

  if (c.logReadings !== undefined && c.logReadings !== null && typeof c.logReadings !== 'boolean') {
    problems.push('logReadings must be true or false');
  }

  const rooms = new Map<string, string>();
  if (!Array.isArray(c.rooms) || c.rooms.length === 0) {
    problems.push('rooms must map at least one device ID to a room key');
  } else {
    c.rooms.forEach((entry: unknown, i: number) => {
      const deviceId = isRecord(entry) && typeof entry.deviceId === 'string' ? entry.deviceId.trim() : '';
      const roomKey = isRecord(entry) && typeof entry.roomKey === 'string' ? entry.roomKey.trim() : '';
      if (!deviceId || !roomKey) {
        problems.push(`rooms[${i}] needs both deviceId and roomKey`);
      } else if (rooms.has(deviceId)) {
        problems.push(`device ${deviceId} is mapped more than once`);
      } else {
        rooms.set(deviceId, roomKey);
      }
    });
  }

  if (problems.length > 0) {
    log.warn(
      `External sensor compensation is OFF because its config is invalid: ${problems.join('; ')}. ` +
      'TCL control is unaffected.',
    );
    return { status: 'invalid' };
  }

  return {
    status: 'on',
    port,
    bindHost,
    token,
    sensorPollIntervalMs: sensorPollIntervalSeconds * 1000,
    logReadings: c.logReadings === true,
    rooms,
    settings: {
      minSetpoint: range.minSetpoint,
      maxSetpoint: range.maxSetpoint,
      step: TARGET_STEP,
      maxOffset,
      smoothingMs: smoothingMinutes * 60_000,
      minChangeIntervalMs: minChangeIntervalSeconds * 1000,
      staleAfterMs: staleAfterSeconds * 1000,
      echoGraceMs: ECHO_GRACE_MS,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
