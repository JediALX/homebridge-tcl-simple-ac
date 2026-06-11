/**
 * Pure conversion logic between TCL split-AC shadow state and HomeKit
 * HeaterCooler characteristic values. No homebridge imports so it stays
 * trivially unit-testable.
 */

/** HAP HeaterCooler characteristic values (kept local to stay dependency-free). */
export const HK = {
  CurrentState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
  TargetState: { AUTO: 0, HEAT: 1, COOL: 2 },
  SwingMode: { DISABLED: 0, ENABLED: 1 },
  Active: { INACTIVE: 0, ACTIVE: 1 },
} as const;

/**
 * workMode values for a split AC supporting all five modes
 * (Auto, Cool, Dehumidify, Fan, Heat — in TCL's enumeration order).
 */
export const WorkMode = {
  AUTO: 0,
  COOL: 1,
  DRY: 2,
  FAN: 3,
  HEAT: 4,
} as const;

export type FanSpeedProfile = 'windSpeed' | 'windSpeed7Gear';

/**
 * Which shadow property controls vertical swing. Older firmwares use
 * `verticalSwitch`; BreezeIN 2.0 firmware exposes `verticalWind` instead.
 */
export type SwingProperty = 'verticalSwitch' | 'verticalWind';

export interface AcState {
  power: boolean;
  workMode: number;
  targetTemperature: number;
  currentTemperature: number;
  fanSpeedProfile: FanSpeedProfile;
  /** Raw value of the active fan-speed property. */
  windSpeed: number;
  /** Only meaningful for the windSpeed7Gear profile. */
  windSpeedAuto: boolean;
  swingProperty: SwingProperty;
  verticalSwing: boolean;
}

function num(reported: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number(reported[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** Extract the state we care about from a shadow `reported` document. */
export function parseShadow(reported: Record<string, unknown>): AcState {
  const has7Gear = reported.windSpeed7Gear !== undefined && reported.windSpeed7Gear !== null;
  const fanSpeedProfile: FanSpeedProfile = has7Gear ? 'windSpeed7Gear' : 'windSpeed';
  const swingProperty: SwingProperty =
    reported.verticalSwitch === undefined && reported.verticalWind !== undefined
      ? 'verticalWind'
      : 'verticalSwitch';
  return {
    power: num(reported, 'powerSwitch') === 1,
    workMode: num(reported, 'workMode'),
    targetTemperature: num(reported, 'targetTemperature', 24),
    currentTemperature: num(reported, 'currentTemperature', 24),
    fanSpeedProfile,
    windSpeed: num(reported, fanSpeedProfile),
    windSpeedAuto: num(reported, 'windSpeedAutoSwitch') === 1,
    swingProperty,
    verticalSwing: num(reported, swingProperty) === 1,
  };
}

export function toActive(state: AcState): number {
  return state.power ? HK.Active.ACTIVE : HK.Active.INACTIVE;
}

export function toCurrentHeaterCoolerState(state: AcState): number {
  if (!state.power) {
    return HK.CurrentState.INACTIVE;
  }
  const { workMode, currentTemperature: current, targetTemperature: target } = state;
  if (workMode === WorkMode.COOL) {
    return current > target ? HK.CurrentState.COOLING : HK.CurrentState.IDLE;
  }
  if (workMode === WorkMode.HEAT) {
    return current < target ? HK.CurrentState.HEATING : HK.CurrentState.IDLE;
  }
  if (workMode === WorkMode.AUTO) {
    if (current > target) {
      return HK.CurrentState.COOLING;
    }
    if (current < target) {
      return HK.CurrentState.HEATING;
    }
    return HK.CurrentState.IDLE;
  }
  // Dry / Fan modes (set from remote) have no HomeKit representation: show Idle.
  return HK.CurrentState.IDLE;
}

/**
 * Target state for HomeKit, or undefined when the AC is in a mode HomeKit
 * cannot represent (Dry/Fan) — callers should then leave the characteristic
 * at its last value.
 */
export function toTargetHeaterCoolerState(state: AcState): number | undefined {
  switch (state.workMode) {
    case WorkMode.AUTO: return HK.TargetState.AUTO;
    case WorkMode.HEAT: return HK.TargetState.HEAT;
    case WorkMode.COOL: return HK.TargetState.COOL;
    default: return undefined;
  }
}

export function fromTargetHeaterCoolerState(value: number): number {
  switch (value) {
    case HK.TargetState.HEAT: return WorkMode.HEAT;
    case HK.TargetState.COOL: return WorkMode.COOL;
    default: return WorkMode.AUTO;
  }
}

export function toSwingMode(state: AcState): number {
  return state.verticalSwing ? HK.SwingMode.ENABLED : HK.SwingMode.DISABLED;
}

/**
 * Fan speed model: the slider is divided into equal positions, the first
 * non-zero position being Auto, the rest the manual gears from low to high.
 */
export interface FanSpeedModel {
  /** RotationSpeed minStep so the Home app slider snaps to positions. */
  minStep: number;
  positions: number;
}

const MANUAL_GEARS: Record<FanSpeedProfile, number[]> = {
  // Legacy 6-value scale: 2=Low ... 6=High (0=Auto).
  windSpeed: [2, 3, 4, 5, 6],
  // 7-gear scale: 1..6 manual (0=Auto, 7=Turbo which we read as max).
  windSpeed7Gear: [1, 2, 3, 4, 5, 6],
};

export function fanSpeedModel(profile: FanSpeedProfile): FanSpeedModel {
  const positions = MANUAL_GEARS[profile].length + 1; // + Auto
  return { positions, minStep: 100 / positions };
}

/** Convert reported fan state to a RotationSpeed percentage. */
export function toRotationSpeed(state: AcState): number {
  const gears = MANUAL_GEARS[state.fanSpeedProfile];
  const { minStep, positions } = fanSpeedModel(state.fanSpeedProfile);
  const isAuto = state.fanSpeedProfile === 'windSpeed7Gear'
    ? state.windSpeedAuto || state.windSpeed === 0
    : state.windSpeed === 0;
  if (isAuto) {
    return Math.round(minStep * 10) / 10;
  }
  const gearIndex = gears.indexOf(state.windSpeed);
  if (gearIndex === -1) {
    // Unknown value (e.g. turbo=7 on the 7-gear scale): show max.
    return 100;
  }
  return Math.round(minStep * (gearIndex + 2) * 10) / 10 > 100
    ? 100
    : Math.round(minStep * (gearIndex + 2) * 10) / 10;
}

export interface FanSpeedCommand {
  windSpeed?: number;
  windSpeed7Gear?: number;
  windSpeedAutoSwitch?: number;
}

/** Convert a RotationSpeed percentage to the TCL desired-state fields. */
export function fromRotationSpeed(percent: number, profile: FanSpeedProfile): FanSpeedCommand {
  const gears = MANUAL_GEARS[profile];
  const { minStep, positions } = fanSpeedModel(profile);
  const position = Math.min(positions, Math.max(1, Math.round(percent / minStep)));

  if (position <= 1) {
    // Auto
    return profile === 'windSpeed7Gear'
      ? { windSpeed7Gear: 0, windSpeedAutoSwitch: 1 }
      : { windSpeed: 0 };
  }
  const gear = gears[position - 2];
  return profile === 'windSpeed7Gear'
    ? { windSpeed7Gear: gear, windSpeedAutoSwitch: 0 }
    : { windSpeed: gear };
}

export function clampTemperature(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}
