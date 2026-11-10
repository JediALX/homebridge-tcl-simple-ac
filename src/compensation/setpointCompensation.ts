/**
 * Closed-loop setpoint compensation for units whose built-in sensor misreads
 * the room. The user's target is what HomeKit shows; the AC is sent a
 * corrected target so that its own thermostat ends up regulating the
 * temperature an external sensor measures:
 *
 *   sentTarget = userTarget + (internalTemp - externalTemp)
 *
 * Patterns:
 *  - Strategy: RoomTemperatureSource (see receiver.ts)
 *  - Ports & Adapters: DeviceSnapshot and ClimateCommandPort are produced and
 *    implemented by the TCL side, so this module knows nothing about the cloud (DIP)
 *  - Memento: CompensationState is persisted by the caller in accessory.context
 *  - Pure core: SetpointCompensator has no I/O and an injectable clock (SRP)
 *
 * State model: the AC has one target shared by all modes, and so does this
 * module. The last value written is remembered together with the mode it was
 * written in, which is what tells a change made in the TCL app or with the IR
 * remote (same mode, different target: adopt it) from a mode switch that
 * leaves our compensated value behind (re-baseline, never adopt).
 */

// ------------------------------------------------------------------ Contracts

export interface TemperatureReading {
  readonly celsius: number;
  /** Epoch ms when the reading arrived. */
  readonly timestamp: number;
}

/** Strategy: anything that can report the real room temperature. */
export interface RoomTemperatureSource {
  latest(): TemperatureReading | undefined;
}

export type RegulationMode = 'heat' | 'cool';

/** Mapped by the TCL side from the state it already polls. No extra cloud calls. */
export interface DeviceSnapshot {
  readonly powerOn: boolean;
  /** Raw TCL workMode, used to notice mode switches. */
  readonly workMode: number;
  /** undefined for auto / dry / fan: compensation only regulates heat and cool. */
  readonly mode: RegulationMode | undefined;
  /** True while a TCL feature owns the setpoint (AI Eco, Sleep, 8 °C heating...). */
  readonly setpointOwnedByPreset: boolean;
  readonly internalTemperature: number;
  readonly deviceTarget: number;
}

/** Port implemented by the TCL side. Rejects when the write did not go through. */
export interface ClimateCommandPort {
  setTargetTemperature(celsius: number): Promise<void>;
}

/** Persisted per accessory in accessory.context. Plain JSON only. */
export interface CompensationState {
  userTarget?: number;
  /** Last target this plugin wrote (or accepted as the baseline), and the mode it applies to. */
  lastSent?: { workMode: number; celsius: number };
}

export interface CompensationSettings {
  readonly minSetpoint: number;
  readonly maxSetpoint: number;
  /** Target resolution the device accepts. */
  readonly step: number;
  /** Clamp on the correction, in °C. */
  readonly maxOffset: number;
  /** Time constant of the offset smoothing; 0 disables smoothing. */
  readonly smoothingMs: number;
  /** Minimum time between automatic writes. User changes bypass it. */
  readonly minChangeIntervalMs: number;
  /** External readings older than this are ignored. Also the startup wait for a first reading. */
  readonly staleAfterMs: number;
  /** After a write, polls may still show the old target for this long. */
  readonly echoGraceMs: number;
}

export interface CompensationLog {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

// --------------------------------------------------------------- Pure core

export class SetpointCompensator {
  private smoothed: number | undefined;
  private updatedAt = 0;

  constructor(
    private readonly settings: CompensationSettings,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Smoothed, clamped correction to add to the user's target. The smoothing is
   * time-based, so it behaves the same whether it is called every 15 s or
   * every 3 min.
   */
  offset(internal: number, external: number): number {
    const raw = internal - external;
    const t = this.now();
    if (this.smoothed === undefined || this.settings.smoothingMs <= 0) {
      this.smoothed = raw;
    } else {
      const alpha = 1 - Math.exp(-(t - this.updatedAt) / this.settings.smoothingMs);
      this.smoothed += alpha * (raw - this.smoothed);
    }
    this.updatedAt = t;
    return clamp(this.smoothed, -this.settings.maxOffset, this.settings.maxOffset);
  }

  /** Rounds to the device step and clamps to the device range. */
  quantize(celsius: number): number {
    const { step, minSetpoint, maxSetpoint } = this.settings;
    return clamp(Math.round(celsius / step) * step, minSetpoint, maxSetpoint);
  }

  reset(): void {
    this.smoothed = undefined;
  }
}

// ------------------------------------------------------------ Orchestrator

export interface ThermostatDeps {
  readonly device: ClimateCommandPort;
  readonly source: RoomTemperatureSource;
  readonly settings: CompensationSettings;
  /** Mutated in place and handed to persist() whenever it changes. */
  readonly state: CompensationState;
  readonly persist: (state: CompensationState) => void;
  readonly log: CompensationLog;
  /** Called when what HomeKit should show changed outside a poll (e.g. an adopted target). */
  readonly onDisplayChange?: () => void;
  readonly now?: () => number;
}

interface PlannedWrite {
  readonly celsius: number;
  readonly workMode: number;
  readonly reason: string;
}

export class CompensatedThermostat {
  private readonly compensator: SetpointCompensator;
  private readonly now: () => number;
  private readonly startedAt: number;

  private lastSnapshot: DeviceSnapshot | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private sending = false;
  private presetActive = false;
  /** A HomeKit change not yet written. Survives an in-flight write and failed writes. */
  private userChangePending = false;
  /** Set by mode switches and preset exits: the next write should not wait for the rate limit. */
  private transitioned = false;
  /** The AC left heat/cool while holding a compensated target: put the user's target back. */
  private restorePending = false;
  /** Last "already set" debug line's key, so it is logged on change rather than every poll. */
  private lastNoopKey: string | undefined;

  constructor(private readonly deps: ThermostatDeps) {
    this.now = deps.now ?? Date.now;
    this.compensator = new SetpointCompensator(deps.settings, this.now);
    this.startedAt = this.now();
  }

  private get state(): CompensationState {
    return this.deps.state;
  }

  private get settings(): CompensationSettings {
    return this.deps.settings;
  }

  /** What HomeKit shows as Heating/CoolingThresholdTemperature. */
  displayedTarget(deviceTarget: number): number {
    return this.state.userTarget ?? deviceTarget;
  }

  /** What HomeKit shows as CurrentTemperature: the room reading while it is fresh. */
  displayedCurrentTemperature(internal: number): number {
    return this.freshExternal()?.celsius ?? internal;
  }

  /** HomeKit set handler. Callers should not await it (HAP flags slow set handlers). */
  async onUserTargetChanged(celsius: number): Promise<void> {
    this.state.userTarget = this.compensator.quantize(celsius);
    this.restorePending = false;
    this.userChangePending = true;
    this.deps.persist(this.state);
    await this.drive();
  }

  /** Call from the existing state poll with the mapped snapshot. */
  async onDeviceState(snap: DeviceSnapshot): Promise<void> {
    this.observe(snap);
    await this.drive();
  }

  // ------------------------------------------------------------- observe

  private observe(snap: DeviceSnapshot): void {
    this.lastSnapshot = snap;
    const state = this.state;

    if (snap.setpointOwnedByPreset) {
      if (!this.presetActive) {
        this.deps.log.debug('a TCL preset owns the setpoint; compensation paused');
      }
      this.presetActive = true;
      this.compensator.reset();
      return;
    }

    if (state.userTarget === undefined || state.lastSent === undefined) {
      state.userTarget ??= snap.deviceTarget;
      state.lastSent = { workMode: snap.workMode, celsius: snap.deviceTarget };
      this.deps.log.info(`compensation: starting from the device's target ${snap.deviceTarget} °C`);
      this.deps.persist(state);
      return;
    }

    const leftPreset = this.presetActive;
    this.presetActive = false;
    const tolerance = this.settings.step / 2;

    if (leftPreset || state.lastSent.workMode !== snap.workMode) {
      // Whatever target the device holds now was not chosen for this mode by
      // the user (our compensated value, or a preset's leftover): re-baseline
      // on it instead of adopting it.
      state.lastSent = { workMode: snap.workMode, celsius: snap.deviceTarget };
      this.compensator.reset();
      this.transitioned = true;
      this.restorePending =
        !this.isRegulating(snap) && Math.abs(snap.deviceTarget - state.userTarget) > tolerance;
      this.deps.log.debug(
        `compensation: ${leftPreset ? 'preset ended' : `mode changed to ${snap.workMode}`}; ` +
        `re-baselined on ${snap.deviceTarget} °C`,
      );
      this.deps.persist(state);
      return;
    }

    const withinGrace = this.now() - this.lastWriteAt < this.settings.echoGraceMs;
    if (!withinGrace && Math.abs(snap.deviceTarget - state.lastSent.celsius) > tolerance) {
      this.deps.log.info(
        `compensation: target changed outside HomeKit (${state.lastSent.celsius} -> ${snap.deviceTarget} °C); ` +
        'adopting it as the user target',
      );
      state.userTarget = snap.deviceTarget;
      state.lastSent = { workMode: snap.workMode, celsius: snap.deviceTarget };
      this.restorePending = false;
      this.compensator.reset();
      this.deps.persist(state);
      this.deps.onDisplayChange?.();
    }
  }

  // ---------------------------------------------------------------- write

  /** Writes until nothing is left to write. Re-entrant calls leave the work to the running loop. */
  private async drive(): Promise<void> {
    if (this.sending) {
      return;
    }
    this.sending = true;
    try {
      for (let planned = this.plan(); planned; planned = this.plan()) {
        if (!(await this.write(planned))) {
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private plan(): PlannedWrite | undefined {
    const snap = this.lastSnapshot;
    const userTarget = this.state.userTarget;
    const lastSent = this.state.lastSent;
    if (!snap || userTarget === undefined || !lastSent) {
      return undefined;
    }

    let candidate: number;
    let reason: string;
    let bypassRateLimit = this.userChangePending || this.transitioned;

    if (this.isRegulating(snap)) {
      const external = this.freshExternal();
      if (external) {
        const offset = this.compensator.offset(snap.internalTemperature, external.celsius);
        candidate = this.compensator.quantize(userTarget + offset);
        reason = `user=${userTarget} internal=${snap.internalTemperature} external=${external.celsius}`;
      } else if (!this.userChangePending && this.now() - this.startedAt < this.settings.staleAfterMs) {
        // Just started: the first push has not arrived yet. Falling back now
        // would undo the compensation only to redo it minutes later.
        return undefined;
      } else {
        this.compensator.reset();
        candidate = this.compensator.quantize(userTarget);
        reason = `user=${userTarget}, no fresh room reading`;
      }
    } else if (this.userChangePending || (this.restorePending && snap.powerOn)) {
      candidate = this.compensator.quantize(userTarget);
      reason = this.userChangePending ? `user=${userTarget}, not regulating` : `user=${userTarget}, left heat/cool`;
      bypassRateLimit = true;
    } else {
      return undefined;
    }

    if (Math.abs(candidate - lastSent.celsius) < 0.01) {
      this.userChangePending = false;
      this.restorePending = false;
      this.transitioned = false;
      const noopKey = `${userTarget}->${candidate}`;
      if (noopKey !== this.lastNoopKey) {
        this.lastNoopKey = noopKey;
        this.deps.log.debug(`compensation: ${reason} -> ${candidate} already set`);
      }
      return undefined;
    }
    if (!bypassRateLimit && this.now() - this.lastWriteAt < this.settings.minChangeIntervalMs) {
      return undefined;
    }
    return { celsius: candidate, workMode: snap.workMode, reason };
  }

  private async write(planned: PlannedWrite): Promise<boolean> {
    // Clear before awaiting, so a HomeKit change arriving mid-write sets it again.
    this.userChangePending = false;
    try {
      await this.deps.device.setTargetTemperature(planned.celsius);
    } catch (e) {
      this.userChangePending = true;
      this.deps.log.warn(`compensation: write failed, will retry on the next poll: ${(e as Error).message}`);
      return false;
    }
    this.lastWriteAt = this.now();
    this.lastNoopKey = undefined;
    this.restorePending = false;
    this.transitioned = false;
    this.state.lastSent = { workMode: planned.workMode, celsius: planned.celsius };
    this.deps.persist(this.state);
    this.deps.log.info(`compensation: ${planned.reason} -> sent ${planned.celsius}`);
    return true;
  }

  // -------------------------------------------------------------- helpers

  private isRegulating(snap: DeviceSnapshot): boolean {
    return snap.powerOn && snap.mode !== undefined && !snap.setpointOwnedByPreset;
  }

  private freshExternal(): TemperatureReading | undefined {
    const reading = this.deps.source.latest();
    return reading && this.now() - reading.timestamp <= this.settings.staleAfterMs ? reading : undefined;
  }
}

// --------------------------------------------------------- Disable path

/**
 * For an accessory whose compensation was switched off while its context still
 * holds CompensationState. If the AC still sits on a target this plugin wrote,
 * put the user's target back. Call on each poll until it returns true; then
 * the caller deletes the state. It waits while the AC is off or in a preset.
 */
export async function releaseCompensation(
  state: CompensationState,
  snap: DeviceSnapshot,
  device: ClimateCommandPort,
  log: CompensationLog,
): Promise<boolean> {
  const { userTarget, lastSent } = state;
  if (userTarget === undefined || lastSent === undefined) {
    return true;
  }
  if (!snap.powerOn || snap.setpointOwnedByPreset) {
    return false;
  }
  const stillOurs = Math.abs(snap.deviceTarget - lastSent.celsius) < 0.01;
  if (!stillOurs || Math.abs(snap.deviceTarget - userTarget) < 0.01) {
    return true;
  }
  try {
    await device.setTargetTemperature(userTarget);
  } catch (e) {
    log.warn(`compensation off: restoring the target failed, will retry: ${(e as Error).message}`);
    return false;
  }
  log.info(`compensation off: restored target ${snap.deviceTarget} -> ${userTarget} °C`);
  return true;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
