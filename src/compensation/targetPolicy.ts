/**
 * The one seam between the accessory and compensation (Strategy). Without
 * compensation config the accessory uses PassThroughPolicy (Null Object),
 * which leaves every value and write exactly as before the feature existed.
 */
import {
  ClimateCommandPort,
  CompensatedThermostat,
  CompensationLog,
  CompensationState,
  DeviceSnapshot,
  releaseCompensation,
} from './setpointCompensation';

export interface TargetTemperaturePolicy {
  /** Heating/CoolingThresholdTemperature, before the accessory's clamp. */
  displayedTarget(deviceTarget: number): number;
  displayedCurrentTemperature(internal: number): number;
  /** True when the policy now owns this HomeKit change; false: write it the usual way. */
  takeUserTarget(celsius: number): boolean;
  /** Called after every applied poll. */
  onDeviceState(snapshot: DeviceSnapshot): Promise<void>;
}

/** Null Object: the plugin's behaviour without compensation. */
export class PassThroughPolicy implements TargetTemperaturePolicy {
  displayedTarget(deviceTarget: number): number {
    return deviceTarget;
  }

  displayedCurrentTemperature(internal: number): number {
    return internal;
  }

  takeUserTarget(_celsius: number): boolean {
    return false;
  }

  async onDeviceState(_snapshot: DeviceSnapshot): Promise<void> {
    // nothing to do
  }
}

export class CompensatingPolicy implements TargetTemperaturePolicy {
  constructor(
    private readonly thermostat: CompensatedThermostat,
    /** Runs the write without blocking the HomeKit set handler, and contains its errors. */
    private readonly runInBackground: (work: Promise<unknown>) => void,
  ) {}

  displayedTarget(deviceTarget: number): number {
    return this.thermostat.displayedTarget(deviceTarget);
  }

  displayedCurrentTemperature(internal: number): number {
    return this.thermostat.displayedCurrentTemperature(internal);
  }

  takeUserTarget(celsius: number): boolean {
    this.runInBackground(this.thermostat.onUserTargetChanged(celsius));
    return true;
  }

  onDeviceState(snapshot: DeviceSnapshot): Promise<void> {
    return this.thermostat.onDeviceState(snapshot);
  }
}

/**
 * Pass-through for a device whose compensation was switched off while its
 * context still holds CompensationState: on each poll, try to put the user's
 * target back, then report so the state can be deleted.
 */
export class ReleasingPolicy extends PassThroughPolicy {
  private busy = false;
  private done = false;

  constructor(
    private readonly state: CompensationState,
    private readonly device: ClimateCommandPort,
    private readonly log: CompensationLog,
    private readonly onReleased: () => void,
  ) {
    super();
  }

  override async onDeviceState(snapshot: DeviceSnapshot): Promise<void> {
    if (this.done || this.busy) {
      return;
    }
    this.busy = true;
    try {
      if (await releaseCompensation(this.state, snapshot, this.device, this.log)) {
        this.done = true;
        this.onReleased();
      }
    } finally {
      this.busy = false;
    }
  }
}
