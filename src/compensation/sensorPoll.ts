import type { CompensationLog } from './setpointCompensation';

/** Port so the trigger does not depend on HAP types. Implemented with a HAP Switch. */
export interface MomentarySwitchPort {
  /** Turn On (which fires the Home automation), then Off again after pulseMs. */
  pulse(pulseMs: number): void;
}

/** Periodically pulses the "Sensor poll" switch so the Home automation pushes readings. */
export class SensorPollTrigger {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly sw: MomentarySwitchPort,
    private readonly intervalMs: number,
    private readonly pulseMs: number,
  ) {}

  start(): void {
    this.sw.pulse(this.pulseMs);
    this.timer = setInterval(() => this.sw.pulse(this.pulseMs), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export interface PushSource {
  lastPushAt(): number | undefined;
  reading(room: string): unknown;
}

/**
 * Logs once when pushes stop arriving (or never start) and once when they
 * resume, plus once per configured room that never shows up. Without pushes
 * the ACs fall back to their plain targets, so this is the main clue when the
 * Home automation silently stops working.
 */
export class PushMonitor {
  private readonly startedAt: number;
  private silent = false;
  private warnedNever = false;
  private readonly warnedRooms = new Set<string>();

  constructor(
    private readonly source: PushSource,
    private readonly rooms: readonly string[],
    private readonly expectedEveryMs: number,
    private readonly log: CompensationLog,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  check(): void {
    const now = this.now();
    const late = 2 * this.expectedEveryMs;
    const last = this.source.lastPushAt();

    if (last === undefined) {
      if (!this.warnedNever && now - this.startedAt > late) {
        this.warnedNever = true;
        this.log.warn(
          'no temperature pushes received since startup; check the Home automation and the shortcut ' +
          '(ACs use their plain targets meanwhile)',
        );
      }
      return;
    }

    if (!this.silent && now - last > late) {
      this.silent = true;
      this.log.info(
        `temperature pushes stopped (last one ${Math.round((now - last) / 60_000)} min ago); ` +
        'ACs fall back to their plain targets',
      );
    } else if (this.silent && now - last <= late) {
      this.silent = false;
      this.log.info('temperature pushes resumed');
    }

    for (const room of this.rooms) {
      if (!this.warnedRooms.has(room) && this.source.reading(room) === undefined && now - this.startedAt > late) {
        this.warnedRooms.add(room);
        this.log.warn(`room "${room}" is configured but no shortcut push has included it`);
      }
    }
  }
}
