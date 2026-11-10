/**
 * Characterisation tests: they pin down how the accessory behaved before
 * external-sensor compensation existed. With compensation off, every one of
 * these must keep passing unchanged (the opt-in contract).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { Characteristic as HapCharacteristic, WithUUID } from '@homebridge/hap-nodejs';

import { TclAcAccessory } from './accessory';
import {
  BREEZEIN_REPORTED,
  Characteristic as C,
  FakeAccessory,
  fakePlatform,
  heaterCooler,
  settle,
  THING,
} from './testing/harness';

type CharType = WithUUID<new () => HapCharacteristic>;

function setup(reported: Record<string, unknown> = BREEZEIN_REPORTED) {
  const fake = fakePlatform(reported);
  const accessory = new FakeAccessory(THING.nickName, 'uuid-1');
  const handler = new TclAcAccessory(fake.platform, accessory as never, THING);
  const service = heaterCooler(accessory);
  const value = (c: CharType) => service.getCharacteristic(c).value;
  const set = async (c: CharType, v: number) => {
    service.getCharacteristic(c).setValue(v);
    await settle();
  };
  return { fake, accessory, handler, service, value, set };
}

/** Run the command debounce and let the publish settle. */
async function flushCommands(): Promise<void> {
  mock.timers.tick(350);
  await settle();
}

describe('accessory (behaviour before compensation)', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 }));
  afterEach(() => mock.timers.reset());

  it('maps a polled state onto the HeaterCooler characteristics', async () => {
    const { handler, value } = setup();
    await handler.poll();
    assert.equal(value(C.Active), 1);
    assert.equal(value(C.TargetHeaterCoolerState), 1); // HEAT
    assert.equal(value(C.CurrentHeaterCoolerState), 1); // IDLE: 23.5 is above 22
    assert.equal(value(C.CurrentTemperature), 23.5);
    assert.equal(value(C.HeatingThresholdTemperature), 22);
    assert.equal(value(C.CoolingThresholdTemperature), 22);
  });

  it('answers reads from the last polled state and fails before the first poll', async () => {
    const { handler, service } = setup();
    await assert.rejects(service.getCharacteristic(C.CurrentTemperature).handleGetRequest());
    await handler.poll();
    assert.equal(await service.getCharacteristic(C.CurrentTemperature).handleGetRequest(), 23.5);
    assert.equal(await service.getCharacteristic(C.HeatingThresholdTemperature).handleGetRequest(), 22);
  });

  it('writes a threshold change as targetTemperature and shows it immediately', async () => {
    const { fake, handler, value, set } = setup();
    await handler.poll();
    await set(C.HeatingThresholdTemperature, 24);
    assert.equal(value(C.HeatingThresholdTemperature), 24);
    assert.equal(value(C.CoolingThresholdTemperature), 24);
    assert.deepEqual(fake.shadow.published, []);
    await flushCommands();
    assert.deepEqual(fake.shadow.published, [{ targetTemperature: 24 }]);
  });

  it('rounds a fractional threshold to whole degrees', async () => {
    const { fake, handler, set } = setup();
    await handler.poll();
    await set(C.CoolingThresholdTemperature, 23.6);
    await flushCommands();
    assert.deepEqual(fake.shadow.published, [{ targetTemperature: 24 }]);
  });

  it('coalesces rapid writes into one publish', async () => {
    const { fake, handler, set } = setup();
    await handler.poll();
    await set(C.TargetHeaterCoolerState, 2); // COOL
    await set(C.CoolingThresholdTemperature, 21);
    await flushCommands();
    assert.deepEqual(fake.shadow.published, [
      { powerSwitch: 1, verticalWind: 0, workMode: 1, targetTemperature: 21 },
    ]);
  });

  it('sends power off, and skips an Active write that matches what is shown', async () => {
    const { fake, handler, set } = setup();
    await handler.poll();
    await set(C.Active, 1);
    await flushCommands();
    assert.deepEqual(fake.shadow.published, []);
    await set(C.Active, 0);
    await flushCommands();
    assert.deepEqual(fake.shadow.published, [{ powerSwitch: 0 }]);
  });

  it('ignores polls for a few seconds after a command (optimistic state wins)', async () => {
    const { fake, handler, value, set } = setup();
    await handler.poll();
    await set(C.HeatingThresholdTemperature, 25);
    await flushCommands();
    // The device has not applied the command yet.
    await handler.poll();
    assert.equal(value(C.HeatingThresholdTemperature), 25);
    mock.timers.tick(6_000);
    await handler.poll();
    assert.equal(value(C.HeatingThresholdTemperature), 22);
  });

  it('re-syncs from the device when a publish fails', async () => {
    const { fake, handler, value, set } = setup();
    await handler.poll();
    fake.shadow.failPublishes = 1;
    await set(C.HeatingThresholdTemperature, 27);
    assert.equal(value(C.HeatingThresholdTemperature), 27);
    await flushCommands();
    assert.equal(value(C.HeatingThresholdTemperature), 22);
    assert.equal(fake.log.at('error').length, 1);
  });

  it('reports whether a queued command was published', async () => {
    const { fake, handler } = setup();
    await handler.poll();
    const ok = handler.queueDesired({ targetTemperature: 25 }, () => {});
    await flushCommands();
    assert.equal(await ok, true);

    mock.timers.tick(6_000);
    fake.shadow.failPublishes = 1;
    const failed = handler.queueDesired({ targetTemperature: 26 }, () => {});
    await flushCommands();
    assert.equal(await failed, false);
  });

  it('makes no cloud calls other than the poll and the user’s commands', async () => {
    const { fake, handler } = setup();
    await handler.poll();
    await handler.poll();
    mock.timers.tick(60_000);
    await settle();
    assert.equal(fake.shadow.getShadowCalls, 2);
    assert.deepEqual(fake.shadow.published, []);
    assert.equal(fake.accessoryUpdates, 0);
  });
});
