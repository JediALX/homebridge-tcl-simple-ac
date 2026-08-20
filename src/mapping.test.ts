import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fanSpeedModel,
  fromRotationSpeed,
  fromTargetHeaterCoolerState,
  HK,
  isDehumidifying,
  parseShadow,
  powerOnCommand,
  toActive,
  toCurrentDehumidifierState,
  toCurrentHeaterCoolerState,
  toDehumidifierActive,
  toRotationSpeed,
  toTargetHeaterCoolerState,
  WorkMode,
} from './mapping';

const baseReported = {
  powerSwitch: 1,
  workMode: WorkMode.COOL,
  targetTemperature: 24,
  currentTemperature: 27,
  windSpeed: 0,
  verticalSwitch: 0,
};

describe('parseShadow', () => {
  it('parses a typical cool-mode shadow', () => {
    const state = parseShadow(baseReported);
    assert.equal(state.power, true);
    assert.equal(state.workMode, WorkMode.COOL);
    assert.equal(state.targetTemperature, 24);
    assert.equal(state.currentTemperature, 27);
    assert.equal(state.fanSpeedProfile, 'windSpeed');
    assert.equal(state.verticalSwing, false);
  });

  it('selects the 7-gear profile when windSpeed7Gear is present', () => {
    const state = parseShadow({ ...baseReported, windSpeed7Gear: 3, windSpeedAutoSwitch: 0 });
    assert.equal(state.fanSpeedProfile, 'windSpeed7Gear');
    assert.equal(state.windSpeed, 3);
  });

  it('uses verticalSwitch for swing when present', () => {
    const state = parseShadow({ ...baseReported, verticalSwitch: 1 });
    assert.equal(state.swingProperty, 'verticalSwitch');
    assert.equal(state.verticalSwing, true);
  });

  it('parses a real BreezeIN 2.0 shadow (verticalWind swing, float temp, 7-gear auto fan)', () => {
    // Trimmed from an actual probe dump of a BreezeIN 2.0 (firmware V8-R82CT20-WFMV206).
    const state = parseShadow({
      powerSwitch: 0,
      targetTemperature: 22,
      currentTemperature: 23.5,
      windSpeed7Gear: 0,
      windSpeedAutoSwitch: 1,
      verticalWind: 0,
      horizontalWind: 0,
      verticalDirection: 8,
      horizontalDirection: 8,
      workMode: 1,
      temperatureType: 0,
      lowerTemperatureLimit: 16,
      upperTemperatureLimit: 31,
    });
    assert.equal(state.power, false);
    assert.equal(state.workMode, WorkMode.COOL);
    assert.equal(state.currentTemperature, 23.5);
    assert.equal(state.fanSpeedProfile, 'windSpeed7Gear');
    assert.equal(state.windSpeedAuto, true);
    assert.equal(state.swingProperty, 'verticalWind');
    assert.equal(state.verticalSwing, false);
  });
});

describe('current heater-cooler state', () => {
  it('is INACTIVE when powered off', () => {
    const state = parseShadow({ ...baseReported, powerSwitch: 0 });
    assert.equal(toCurrentHeaterCoolerState(state), HK.CurrentState.INACTIVE);
  });

  it('cools when above setpoint in cool mode, idles at/below it', () => {
    assert.equal(
      toCurrentHeaterCoolerState(parseShadow(baseReported)),
      HK.CurrentState.COOLING,
    );
    assert.equal(
      toCurrentHeaterCoolerState(parseShadow({ ...baseReported, currentTemperature: 23 })),
      HK.CurrentState.IDLE,
    );
  });

  it('heats when below setpoint in heat mode', () => {
    const state = parseShadow({
      ...baseReported, workMode: WorkMode.HEAT, currentTemperature: 18, targetTemperature: 22,
    });
    assert.equal(toCurrentHeaterCoolerState(state), HK.CurrentState.HEATING);
  });

  it('derives heating/cooling from temperature delta in auto mode', () => {
    const auto = { ...baseReported, workMode: WorkMode.AUTO };
    assert.equal(toCurrentHeaterCoolerState(parseShadow(auto)), HK.CurrentState.COOLING);
    assert.equal(
      toCurrentHeaterCoolerState(parseShadow({ ...auto, currentTemperature: 20 })),
      HK.CurrentState.HEATING,
    );
    assert.equal(
      toCurrentHeaterCoolerState(parseShadow({ ...auto, currentTemperature: 24 })),
      HK.CurrentState.IDLE,
    );
  });

  it('shows IDLE for Dry and Fan modes set from the remote', () => {
    for (const workMode of [WorkMode.DRY, WorkMode.FAN]) {
      assert.equal(
        toCurrentHeaterCoolerState(parseShadow({ ...baseReported, workMode })),
        HK.CurrentState.IDLE,
      );
    }
  });
});

describe('target heater-cooler state', () => {
  it('maps Auto/Heat/Cool both ways', () => {
    assert.equal(toTargetHeaterCoolerState(parseShadow({ ...baseReported, workMode: WorkMode.AUTO })), HK.TargetState.AUTO);
    assert.equal(toTargetHeaterCoolerState(parseShadow({ ...baseReported, workMode: WorkMode.HEAT })), HK.TargetState.HEAT);
    assert.equal(toTargetHeaterCoolerState(parseShadow(baseReported)), HK.TargetState.COOL);
    assert.equal(fromTargetHeaterCoolerState(HK.TargetState.AUTO), WorkMode.AUTO);
    assert.equal(fromTargetHeaterCoolerState(HK.TargetState.HEAT), WorkMode.HEAT);
    assert.equal(fromTargetHeaterCoolerState(HK.TargetState.COOL), WorkMode.COOL);
  });

  it('is undefined for Dry/Fan so HomeKit keeps the last value', () => {
    assert.equal(toTargetHeaterCoolerState(parseShadow({ ...baseReported, workMode: WorkMode.DRY })), undefined);
    assert.equal(toTargetHeaterCoolerState(parseShadow({ ...baseReported, workMode: WorkMode.FAN })), undefined);
  });
});

describe('dehumidifier mapping', () => {
  const drying = parseShadow({ ...baseReported, workMode: WorkMode.DRY });
  const dryingOff = parseShadow({ ...baseReported, workMode: WorkMode.DRY, powerSwitch: 0 });

  it('is active and dehumidifying only when powered on in dry mode', () => {
    assert.equal(isDehumidifying(drying), true);
    assert.equal(toDehumidifierActive(drying), HK.Active.ACTIVE);
    assert.equal(toCurrentDehumidifierState(drying), HK.DehumidifierState.DEHUMIDIFYING);

    assert.equal(isDehumidifying(dryingOff), false);
    assert.equal(toDehumidifierActive(dryingOff), HK.Active.INACTIVE);
    assert.equal(toCurrentDehumidifierState(dryingOff), HK.DehumidifierState.INACTIVE);

    const cooling = parseShadow(baseReported);
    assert.equal(isDehumidifying(cooling), false);
    assert.equal(toDehumidifierActive(cooling), HK.Active.INACTIVE);
  });

  it('AC tile reports dry mode as off only with dryAsOff', () => {
    assert.equal(toActive(drying, true), HK.Active.INACTIVE);
    assert.equal(toCurrentHeaterCoolerState(drying, true), HK.CurrentState.INACTIVE);
    // Without the flag, v0.1.0 behavior is unchanged: on and Idle.
    assert.equal(toActive(drying), HK.Active.ACTIVE);
    assert.equal(toCurrentHeaterCoolerState(drying), HK.CurrentState.IDLE);
  });

  it('dryAsOff does not affect other modes', () => {
    const cooling = parseShadow(baseReported);
    assert.equal(toActive(cooling, true), HK.Active.ACTIVE);
    assert.equal(toCurrentHeaterCoolerState(cooling, true), HK.CurrentState.COOLING);
    const fanOnly = parseShadow({ ...baseReported, workMode: WorkMode.FAN });
    assert.equal(toActive(fanOnly, true), HK.Active.ACTIVE);
    assert.equal(toCurrentHeaterCoolerState(fanOnly, true), HK.CurrentState.IDLE);
  });

  it('handles a real BreezeIN 2.0 shadow switched to dry mode', () => {
    const state = parseShadow({
      powerSwitch: 1,
      targetTemperature: 22,
      currentTemperature: 23.5,
      windSpeed7Gear: 0,
      windSpeedAutoSwitch: 1,
      verticalWind: 0,
      horizontalWind: 0,
      workMode: 2,
      temperatureType: 0,
    });
    assert.equal(isDehumidifying(state), true);
    assert.equal(toDehumidifierActive(state), HK.Active.ACTIVE);
    assert.equal(toActive(state, true), HK.Active.INACTIVE);
    // Dry mode is unrepresentable on the AC tile; HomeKit keeps the last target.
    assert.equal(toTargetHeaterCoolerState(state), undefined);
  });
});

describe('power-on command', () => {
  it('pins swing off when HomeKit shows oscillation off', () => {
    const state = parseShadow({ ...baseReported, powerSwitch: 0, verticalSwitch: 0 });
    assert.deepEqual(powerOnCommand(state), { powerSwitch: 1, verticalSwitch: 0 });
  });

  it('keeps swing on when HomeKit shows oscillation on', () => {
    const state = parseShadow({ ...baseReported, verticalSwitch: 1 });
    assert.deepEqual(powerOnCommand(state), { powerSwitch: 1, verticalSwitch: 1 });
  });

  it('uses the firmware\'s own swing property (BreezeIN 2.0 verticalWind)', () => {
    const state = parseShadow({
      powerSwitch: 0, workMode: 1, targetTemperature: 22, currentTemperature: 23.5,
      windSpeed7Gear: 0, windSpeedAutoSwitch: 1, verticalWind: 1,
    });
    assert.deepEqual(powerOnCommand(state), { powerSwitch: 1, verticalWind: 1 });
  });

  it('falls back to verticalSwitch before the first poll', () => {
    assert.deepEqual(powerOnCommand(null), { powerSwitch: 1, verticalSwitch: 0 });
  });
});

describe('fan speed mapping', () => {
  it('legacy windSpeed profile has 6 slider positions (auto + 5 gears)', () => {
    const model = fanSpeedModel('windSpeed');
    assert.equal(model.positions, 6);
  });

  it('round-trips every legacy gear', () => {
    for (const gear of [2, 3, 4, 5, 6]) {
      const state = parseShadow({ ...baseReported, windSpeed: gear });
      const percent = toRotationSpeed(state);
      assert.deepEqual(fromRotationSpeed(percent, 'windSpeed'), { windSpeed: gear });
    }
  });

  it('maps auto to the first slider position and back', () => {
    const state = parseShadow({ ...baseReported, windSpeed: 0 });
    const percent = toRotationSpeed(state);
    assert.equal(percent, Math.round((100 / 6) * 10) / 10);
    assert.deepEqual(fromRotationSpeed(percent, 'windSpeed'), { windSpeed: 0 });
  });

  it('round-trips 7-gear values with the auto switch', () => {
    for (const gear of [1, 2, 3, 4, 5, 6]) {
      const state = parseShadow({
        ...baseReported, windSpeed7Gear: gear, windSpeedAutoSwitch: 0,
      });
      const percent = toRotationSpeed(state);
      assert.deepEqual(
        fromRotationSpeed(percent, 'windSpeed7Gear'),
        { windSpeed7Gear: gear, windSpeedAutoSwitch: 0 },
      );
    }
    const auto = parseShadow({ ...baseReported, windSpeed7Gear: 0, windSpeedAutoSwitch: 1 });
    assert.deepEqual(
      fromRotationSpeed(toRotationSpeed(auto), 'windSpeed7Gear'),
      { windSpeed7Gear: 0, windSpeedAutoSwitch: 1 },
    );
  });

  it('reports 0 while the unit is off', () => {
    assert.equal(toRotationSpeed(parseShadow({ ...baseReported, powerSwitch: 0, windSpeed: 4 })), 0);
    // ...and the real speed again once it is on.
    assert.ok(toRotationSpeed(parseShadow({ ...baseReported, windSpeed: 4 })) > 0);
  });

  it('treats unknown turbo value as max speed', () => {
    const state = parseShadow({ ...baseReported, windSpeed7Gear: 7, windSpeedAutoSwitch: 0 });
    assert.equal(toRotationSpeed(state), 100);
  });

  it('maps 100% to the highest gear', () => {
    assert.deepEqual(fromRotationSpeed(100, 'windSpeed'), { windSpeed: 6 });
    assert.deepEqual(fromRotationSpeed(100, 'windSpeed7Gear'), { windSpeed7Gear: 6, windSpeedAutoSwitch: 0 });
  });
});
