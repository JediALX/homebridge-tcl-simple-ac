import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  AcState,
  clampTemperature,
  fanSpeedModel,
  fromRotationSpeed,
  fromTargetHeaterCoolerState,
  HK,
  parseShadow,
  toActive,
  toCurrentHeaterCoolerState,
  toRotationSpeed,
  toSwingMode,
  toTargetHeaterCoolerState,
} from './mapping';
import { TclSimpleAcPlatform } from './platform';
import { TclThing } from './tcl/api';

/** How long after a command we trust our optimistic state over polled state. */
const POLL_SUPPRESS_MS = 5_000;
/** Quiet period used to coalesce rapid characteristic writes into one publish. */
const COMMAND_DEBOUNCE_MS = 350;
/** Consecutive poll failures before the accessory reports "Not Responding". */
const MAX_POLL_FAILURES = 5;

export class TclAcAccessory {
  private readonly service: Service;
  private state: AcState | null = null;
  private lastTargetState: number = HK.TargetState.AUTO;

  private pendingDesired: Record<string, unknown> = {};
  private commandTimer?: NodeJS.Timeout;
  private suppressPollUntil = 0;
  private pollFailures = 0;
  private fanPropsConfigured = false;

  constructor(
    private readonly platform: TclSimpleAcPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly thing: TclThing,
  ) {
    const { Service: S, Characteristic: C } = platform;

    const info = this.accessory.getService(S.AccessoryInformation)!;
    info
      .setCharacteristic(C.Manufacturer, 'TCL')
      .setCharacteristic(C.Model, thing.deviceType || thing.deviceName || 'Split AC')
      .setCharacteristic(C.SerialNumber, thing.deviceId)
      .setCharacteristic(C.FirmwareRevision, thing.firmwareVersion || '0.0.0');

    this.service =
      this.accessory.getService(S.HeaterCooler) ?? this.accessory.addService(S.HeaterCooler);
    this.service.setCharacteristic(C.Name, thing.nickName);

    this.service.getCharacteristic(C.Active)
      .onGet(() => this.getValue((s) => toActive(s)))
      .onSet((value) => this.setActive(value));

    this.service.getCharacteristic(C.CurrentHeaterCoolerState)
      .onGet(() => this.getValue((s) => toCurrentHeaterCoolerState(s)));

    this.service.getCharacteristic(C.TargetHeaterCoolerState)
      .onGet(() => this.getValue((s) => toTargetHeaterCoolerState(s) ?? this.lastTargetState))
      .onSet((value) => this.setTargetState(value));

    this.service.getCharacteristic(C.CurrentTemperature)
      .onGet(() => this.getValue((s) => s.currentTemperature));

    const tempProps = {
      minValue: platform.minTemp,
      maxValue: platform.maxTemp,
      minStep: 1,
    };
    this.service.getCharacteristic(C.CoolingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this.getValue((s) => this.clampTemp(s.targetTemperature)))
      .onSet((value) => this.setTargetTemperature(value));
    this.service.getCharacteristic(C.HeatingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this.getValue((s) => this.clampTemp(s.targetTemperature)))
      .onSet((value) => this.setTargetTemperature(value));

    this.service.getCharacteristic(C.RotationSpeed)
      .onGet(() => this.getValue((s) => toRotationSpeed(s)))
      .onSet((value) => this.setRotationSpeed(value));

    this.service.getCharacteristic(C.SwingMode)
      .onGet(() => this.getValue((s) => toSwingMode(s)))
      .onSet((value) => this.setSwingMode(value));
  }

  private clampTemp(value: number): number {
    return clampTemperature(value, this.platform.minTemp, this.platform.maxTemp);
  }

  private getValue<T extends CharacteristicValue>(selector: (state: AcState) => T): T {
    if (!this.state || this.pollFailures >= MAX_POLL_FAILURES) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    return selector(this.state);
  }

  // ---- HomeKit -> TCL ----

  private setActive(value: CharacteristicValue): void {
    const on = value === HK.Active.ACTIVE;
    if (this.state?.power === on) {
      return; // Home app re-sends Active alongside other writes; don't spam the AC.
    }
    this.queueDesired({ powerSwitch: on ? 1 : 0 }, (s) => {
      s.power = on;
    });
  }

  private setTargetState(value: CharacteristicValue): void {
    const workMode = fromTargetHeaterCoolerState(value as number);
    this.lastTargetState = value as number;
    this.queueDesired({ workMode, powerSwitch: 1 }, (s) => {
      s.workMode = workMode;
      s.power = true;
    });
  }

  private setTargetTemperature(value: CharacteristicValue): void {
    const target = this.clampTemp(value as number);
    this.queueDesired({ targetTemperature: target }, (s) => {
      s.targetTemperature = target;
    });
  }

  private setRotationSpeed(value: CharacteristicValue): void {
    const percent = value as number;
    if (percent <= 0) {
      // The Home app drags the slider to 0 when switching the unit off; it
      // also sends Active=0 separately, so nothing to publish for the fan.
      return;
    }
    const profile = this.state?.fanSpeedProfile ?? 'windSpeed';
    const command = fromRotationSpeed(percent, profile);
    this.queueDesired({ ...command }, (s) => {
      if (command.windSpeed7Gear !== undefined) {
        s.windSpeed = command.windSpeed7Gear;
        s.windSpeedAuto = command.windSpeedAutoSwitch === 1;
      } else if (command.windSpeed !== undefined) {
        s.windSpeed = command.windSpeed;
      }
    });
  }

  private setSwingMode(value: CharacteristicValue): void {
    const enabled = value === HK.SwingMode.ENABLED;
    const property = this.state?.swingProperty ?? 'verticalSwitch';
    this.queueDesired({ [property]: enabled ? 1 : 0 }, (s) => {
      s.verticalSwing = enabled;
    });
  }

  /**
   * Merge a partial desired state into the pending command, optimistically
   * update local state, and (re)arm the debounce timer so rapid writes from
   * the Home app coalesce into a single shadow publish.
   */
  private queueDesired(desired: Record<string, unknown>, applyOptimistic: (state: AcState) => void): void {
    Object.assign(this.pendingDesired, desired);
    if (this.state) {
      applyOptimistic(this.state);
      this.pushState();
    }
    this.suppressPollUntil = Date.now() + POLL_SUPPRESS_MS;
    if (this.commandTimer) {
      clearTimeout(this.commandTimer);
    }
    this.commandTimer = setTimeout(() => void this.flushCommands(), COMMAND_DEBOUNCE_MS);
  }

  private async flushCommands(): Promise<void> {
    const desired = this.pendingDesired;
    this.pendingDesired = {};
    if (Object.keys(desired).length === 0) {
      return;
    }
    try {
      this.platform.log.debug('[%s] publishing desired state: %j', this.thing.nickName, desired);
      await this.platform.shadow.setDesiredState(this.thing.deviceId, desired);
      this.suppressPollUntil = Date.now() + POLL_SUPPRESS_MS;
    } catch (e) {
      this.platform.log.error(
        '[%s] failed to send command %j: %s',
        this.thing.nickName, desired, (e as Error).message,
      );
      // Re-sync from the device so HomeKit doesn't keep showing the failed optimistic state.
      this.suppressPollUntil = 0;
      await this.poll();
    }
  }

  // ---- TCL -> HomeKit ----

  async poll(): Promise<void> {
    try {
      const shadowDoc = await this.platform.shadow.getShadow(this.thing.deviceId);
      this.pollFailures = 0;
      if (Date.now() < this.suppressPollUntil) {
        return;
      }
      const reported = shadowDoc.state?.reported;
      if (!reported) {
        this.platform.log.warn('[%s] shadow has no reported state', this.thing.nickName);
        return;
      }
      this.state = parseShadow(reported);
      this.configureFanProps();
      const target = toTargetHeaterCoolerState(this.state);
      if (target !== undefined) {
        this.lastTargetState = target;
      }
      this.pushState();
    } catch (e) {
      this.pollFailures++;
      const level = this.pollFailures === 1 || this.pollFailures === MAX_POLL_FAILURES ? 'warn' : 'debug';
      this.platform.log[level](
        '[%s] poll failed (%d consecutive): %s',
        this.thing.nickName, this.pollFailures, (e as Error).message,
      );
    }
  }

  /** Set the RotationSpeed step size once we know which fan-speed scale the unit uses. */
  private configureFanProps(): void {
    if (this.fanPropsConfigured || !this.state) {
      return;
    }
    const { minStep } = fanSpeedModel(this.state.fanSpeedProfile);
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep });
    this.fanPropsConfigured = true;
  }

  private pushState(): void {
    const s = this.state;
    if (!s) {
      return;
    }
    const { Characteristic: C } = this.platform;
    this.service.updateCharacteristic(C.Active, toActive(s));
    this.service.updateCharacteristic(C.CurrentHeaterCoolerState, toCurrentHeaterCoolerState(s));
    const target = toTargetHeaterCoolerState(s);
    this.service.updateCharacteristic(C.TargetHeaterCoolerState, target ?? this.lastTargetState);
    this.service.updateCharacteristic(C.CurrentTemperature, s.currentTemperature);
    this.service.updateCharacteristic(C.CoolingThresholdTemperature, this.clampTemp(s.targetTemperature));
    this.service.updateCharacteristic(C.HeatingThresholdTemperature, this.clampTemp(s.targetTemperature));
    this.service.updateCharacteristic(C.RotationSpeed, toRotationSpeed(s));
    this.service.updateCharacteristic(C.SwingMode, toSwingMode(s));
  }
}
