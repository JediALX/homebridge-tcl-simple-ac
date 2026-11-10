import { PlatformAccessory, Service } from 'homebridge';

import type { MomentarySwitchPort } from './compensation/sensorPoll';
import { SENSOR_POLL_PULSE_MS } from './compensation/config';
import type { TclSimpleAcPlatform } from './platform';

/**
 * The "Sensor poll" accessory: a momentary HAP Switch whose turning On fires
 * the user's Home automation that pushes room temperatures. Tapping it in the
 * Home app does the same (handy while setting the automation up); it then
 * turns itself Off like a timed pulse.
 */
export class SensorPollSwitch implements MomentarySwitchPort {
  private readonly service: Service;
  private offTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: Pick<TclSimpleAcPlatform, 'Service' | 'Characteristic'>,
    accessory: PlatformAccessory,
  ) {
    const { Service: S, Characteristic: C } = platform;
    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'homebridge-tcl-simple-ac')
      .setCharacteristic(C.Model, 'Sensor poll trigger')
      .setCharacteristic(C.SerialNumber, 'sensor-poll');

    this.service = accessory.getService(S.Switch) ?? accessory.addService(S.Switch, 'Sensor poll');
    this.service.setCharacteristic(C.Name, 'Sensor poll');
    this.service.getCharacteristic(C.On)
      .updateValue(false)
      .onSet((value) => {
        if (value) {
          this.scheduleOff(SENSOR_POLL_PULSE_MS);
        }
      });
  }

  pulse(pulseMs: number): void {
    const C = this.platform.Characteristic;
    if (this.service.getCharacteristic(C.On).value) {
      // Make sure HomeKit sees an Off -> On transition, which is what triggers the automation.
      this.service.updateCharacteristic(C.On, false);
    }
    this.service.updateCharacteristic(C.On, true);
    this.scheduleOff(pulseMs);
  }

  stop(): void {
    clearTimeout(this.offTimer);
  }

  private scheduleOff(ms: number): void {
    clearTimeout(this.offTimer);
    this.offTimer = setTimeout(() => this.service.updateCharacteristic(this.platform.Characteristic.On, false), ms);
  }
}
