import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import { TclAcAccessory } from './accessory';
import {
  AcState,
  HK,
  isDehumidifying,
  SYNTHETIC_HUMIDITY,
  toCurrentDehumidifierState,
  toDehumidifierActive,
  WorkMode,
} from './mapping';
import { TclSimpleAcPlatform } from './platform';
import { TclThing } from './tcl/api';

/**
 * Optional satellite accessory exposing the AC's Dry mode as a HomeKit
 * dehumidifier. It owns no cloud connection of its own: state and commands
 * go through the device's TclAcAccessory, which polls the shadow and pushes
 * every update here via pushState().
 */
export class TclDehumidifierAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: TclSimpleAcPlatform,
    private readonly accessory: PlatformAccessory,
    thing: TclThing,
    private readonly ac: TclAcAccessory,
  ) {
    const { Service: S, Characteristic: C } = platform;

    const info = this.accessory.getService(S.AccessoryInformation)!;
    info
      .setCharacteristic(C.Manufacturer, 'TCL')
      .setCharacteristic(C.Model, thing.deviceType || thing.deviceName || 'Split AC')
      .setCharacteristic(C.SerialNumber, `${thing.deviceId}-D`)
      .setCharacteristic(C.FirmwareRevision, thing.firmwareVersion || '0.0.0');

    this.service =
      this.accessory.getService(S.HumidifierDehumidifier)
      ?? this.accessory.addService(S.HumidifierDehumidifier);
    this.service.setCharacteristic(C.Name, `${thing.nickName} Dehumidifier`);
    this.service.setPrimaryService(true);

    this.service.getCharacteristic(C.Active)
      .onGet(() => toDehumidifierActive(this.ac.snapshot()))
      .onSet((value) => this.setActive(value));

    this.service.getCharacteristic(C.CurrentHumidifierDehumidifierState)
      .setProps({
        validValues: [HK.DehumidifierState.INACTIVE, HK.DehumidifierState.DEHUMIDIFYING],
      })
      .onGet(() => toCurrentDehumidifierState(this.ac.snapshot()));

    this.service.getCharacteristic(C.TargetHumidifierDehumidifierState)
      // Raise the value above the new minimum before restricting the props,
      // or setProps logs an "illegal value" warning at startup.
      .updateValue(HK.DehumidifierTarget.DEHUMIDIFIER)
      .setProps({
        validValues: [HK.DehumidifierTarget.DEHUMIDIFIER],
        minValue: HK.DehumidifierTarget.DEHUMIDIFIER,
        maxValue: HK.DehumidifierTarget.DEHUMIDIFIER,
      })
      .onGet(() => HK.DehumidifierTarget.DEHUMIDIFIER)
      .onSet(() => { /* only Dehumidifier is valid; nothing to do */ });

    this.service.getCharacteristic(C.CurrentRelativeHumidity)
      .onGet(() => SYNTHETIC_HUMIDITY);
  }

  private setActive(value: CharacteristicValue): void {
    const on = value === HK.Active.ACTIVE;
    const state = this.ac.currentState;
    if (state && isDehumidifying(state) === on) {
      return; // Home app re-sends Active alongside other writes; don't spam the AC.
    }
    if (on) {
      this.ac.queueDesired(this.ac.powerOnDesired({ workMode: WorkMode.DRY }), (s) => {
        s.workMode = WorkMode.DRY;
        s.power = true;
      });
    } else if (state && isDehumidifying(state)) {
      this.ac.queueDesired({ powerSwitch: 0 }, (s) => {
        s.power = false;
      });
    }
  }

  /** Called by the AC handler on every poll and optimistic update. */
  pushState(state: AcState): void {
    const { Characteristic: C } = this.platform;
    this.service.updateCharacteristic(C.Active, toDehumidifierActive(state));
    this.service.updateCharacteristic(C.CurrentHumidifierDehumidifierState, toCurrentDehumidifierState(state));
    this.service.updateCharacteristic(C.CurrentRelativeHumidity, SYNTHETIC_HUMIDITY);
  }
}
