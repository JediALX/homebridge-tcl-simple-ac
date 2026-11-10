import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SensorPollSwitch } from './sensorPollSwitch';
import { Characteristic as C, FakeAccessory, Service } from './testing/harness';

function setup() {
  const accessory = new FakeAccessory('Sensor poll', 'uuid-sensor');
  const sw = new SensorPollSwitch({ Service, Characteristic: C } as never, accessory as never);
  const on = accessory.getService(Service.Switch)!.getCharacteristic(C.On);
  const changes: unknown[] = [];
  on.on('change', (change: { newValue: unknown }) => changes.push(change.newValue));
  return { sw, on, changes };
}

describe('SensorPollSwitch', () => {
  it('starts Off, pulses On, and turns itself Off after the pulse', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { sw, on } = setup();
    assert.equal(on.value, false);
    sw.pulse(3_000);
    assert.equal(on.value, true);
    t.mock.timers.tick(2_999);
    assert.equal(on.value, true);
    t.mock.timers.tick(1);
    assert.equal(on.value, false);
  });

  it('always produces an Off -> On transition, even if still On', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { sw, changes } = setup();
    sw.pulse(3_000);
    sw.pulse(3_000);
    assert.deepEqual(changes, [true, false, true]);
  });

  it('turns itself Off after a tap in the Home app', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { on } = setup();
    await on.handleSetRequest(true);
    assert.equal(on.value, true);
    t.mock.timers.tick(3_000);
    assert.equal(on.value, false);
  });
});
