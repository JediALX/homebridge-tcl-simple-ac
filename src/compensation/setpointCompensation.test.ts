import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CompensatedThermostat,
  CompensationSettings,
  CompensationState,
  DeviceSnapshot,
  releaseCompensation,
  SetpointCompensator,
  TemperatureReading,
} from './setpointCompensation';

const HEAT = 4;
const COOL = 1;
const AUTO = 0;
const MIN = 60_000;

const SETTINGS: CompensationSettings = {
  minSetpoint: 16,
  maxSetpoint: 31,
  step: 1,
  maxOffset: 5,
  smoothingMs: 0, // most scenarios check the arithmetic; smoothing has its own tests
  minChangeIntervalMs: 3 * MIN,
  staleAfterMs: 10 * MIN,
  echoGraceMs: 90_000,
};

function heat(o: Partial<DeviceSnapshot> = {}): DeviceSnapshot {
  return {
    powerOn: true,
    workMode: HEAT,
    mode: 'heat',
    setpointOwnedByPreset: false,
    internalTemperature: 23,
    deviceTarget: 22,
    ...o,
  };
}
const cool = (o: Partial<DeviceSnapshot> = {}) => heat({ workMode: COOL, mode: 'cool', ...o });
const auto = (o: Partial<DeviceSnapshot> = {}) => heat({ workMode: AUTO, mode: undefined, ...o });

const silentLog = { info: () => {}, warn: () => {}, debug: () => {} };

function rig(opts: { state?: CompensationState; external?: number; settings?: Partial<CompensationSettings> } = {}) {
  let now = 10_000_000;
  let reading: TemperatureReading | undefined =
    opts.external === undefined ? undefined : { celsius: opts.external, timestamp: now };
  const sent: number[] = [];
  const persisted: CompensationState[] = [];
  let failures = 0;
  let gate: Promise<void> | undefined;
  let displayChanges = 0;
  const state: CompensationState = opts.state ?? {};
  const thermostat = new CompensatedThermostat({
    device: {
      setTargetTemperature: async (celsius) => {
        sent.push(celsius);
        if (gate) await gate;
        if (failures > 0) {
          failures--;
          throw new Error('cloud down');
        }
      },
    },
    source: { latest: () => reading },
    settings: { ...SETTINGS, ...opts.settings },
    state,
    persist: (s) => persisted.push(JSON.parse(JSON.stringify(s))),
    log: silentLog,
    onDisplayChange: () => { displayChanges++; },
    now: () => now,
  });
  return {
    t: thermostat,
    sent,
    state,
    persisted,
    get displayChanges() { return displayChanges; },
    advance(ms: number) { now += ms; },
    /** A fresh push from the Home automation. */
    push(celsius: number) { reading = { celsius, timestamp: now }; },
    noReading() { reading = undefined; },
    failNext(n = 1) { failures = n; },
    hold(): () => void {
      let release!: () => void;
      gate = new Promise((r) => { release = r; });
      return () => { gate = undefined; release(); };
    },
  };
}

describe('CompensatedThermostat', () => {
  it('adopts the device target on first run and sends the compensated target', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat({ internalTemperature: 23, deviceTarget: 22 }));
    assert.deepEqual(r.sent, [26]);
    assert.equal(r.t.displayedTarget(26), 22);
    assert.deepEqual(r.state, { userTarget: 22, lastSent: { workMode: HEAT, celsius: 26 } });
  });

  it('does not mistake a poll that still shows the pre-write target for a manual change', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(30_000);
    await r.t.onDeviceState(heat({ deviceTarget: 22 })); // the device has not applied 26 yet
    assert.equal(r.state.userTarget, 22);
  });

  it('adopts a target changed in the TCL app or by remote outside the grace window', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(4 * MIN);
    r.push(19);
    await r.t.onDeviceState(heat({ deviceTarget: 24 }));
    assert.equal(r.state.userTarget, 24);
    assert.equal(r.displayChanges, 1);
    assert.equal(r.t.displayedTarget(24), 24);
  });

  it('leaves a preset alone and does not adopt its leftover target', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(4 * MIN);
    r.push(19);
    await r.t.onDeviceState(heat({ setpointOwnedByPreset: true, deviceTarget: 28 }));
    assert.deepEqual(r.sent, [26]);
    r.advance(20_000);
    await r.t.onDeviceState(heat({ deviceTarget: 28 })); // preset over, 28 left behind
    assert.equal(r.state.userTarget, 22);
    assert.deepEqual(r.sent, [26, 26], 'compensation resumes at once from the stored user target');
  });

  it('falls back to the plain user target when the room reading goes stale', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(11 * MIN); // last push is now too old
    await r.t.onDeviceState(heat({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, [26, 22]);
    assert.equal(r.t.displayedCurrentTemperature(23), 23);
  });

  it('shows the room reading as CurrentTemperature while it is fresh', async () => {
    const r = rig({ external: 19.4 });
    assert.equal(r.t.displayedCurrentTemperature(23), 19.4);
  });

  it('clamps the correction to maxOffset', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat({ internalTemperature: 30 }));
    assert.deepEqual(r.sent, [27]);
  });

  it('rate-limits automatic writes but not HomeKit changes', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(MIN);
    r.push(18);
    await r.t.onDeviceState(heat({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, [26], 'automatic change waits for minChangeInterval');
    await r.t.onUserTargetChanged(23);
    assert.deepEqual(r.sent, [26, 28]);
    assert.equal(r.t.displayedTarget(28), 23);
  });

  it('writes a HomeKit change as-is while the AC is off', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat({ powerOn: false }));
    await r.t.onUserTargetChanged(24);
    assert.deepEqual(r.sent, [24]);
  });

  // ---- the bugs found in the handover's reference implementation ----

  it('switching heat -> cool keeps the user target instead of adopting the compensated one', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(4 * MIN);
    r.push(25);
    await r.t.onDeviceState(cool({ internalTemperature: 27, deviceTarget: 26 }));
    assert.equal(r.state.userTarget, 22);
    assert.deepEqual(r.sent, [26, 24], 'cool regulates from 22 right away: 22 + (27 - 25)');
  });

  it('a unit that remembers a target per mode does not stack the offset when switching back', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat()); // sends 26
    r.advance(4 * MIN);
    r.push(25);
    await r.t.onDeviceState(cool({ internalTemperature: 27, deviceTarget: 23 })); // cool's own memory
    r.advance(4 * MIN);
    r.push(19);
    await r.t.onDeviceState(heat({ deviceTarget: 26 })); // heat's memory: our old compensated value
    assert.equal(r.state.userTarget, 22);
    assert.deepEqual(r.sent, [26, 24], 'cool regulated from 22 (22 + 2); back in heat 26 is already right');
  });

  it('switching to auto puts the user target back', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(20_000);
    await r.t.onDeviceState(auto({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, [26, 22]);
  });

  it('a mode switch made while off restores the target once the AC is on', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat());
    r.advance(20_000);
    await r.t.onDeviceState(auto({ powerOn: false, deviceTarget: 26 }));
    assert.deepEqual(r.sent, [26]);
    await r.t.onDeviceState(auto({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, [26, 22]);
  });

  it('after a restart, waits for the first reading instead of undoing the compensation', async () => {
    const persisted: CompensationState = { userTarget: 22, lastSent: { workMode: HEAT, celsius: 26 } };
    const r = rig({ state: persisted });
    await r.t.onDeviceState(heat({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, []);
    r.advance(3 * MIN);
    r.push(19);
    await r.t.onDeviceState(heat({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, [], 'already on 26: nothing to write, offset not stacked');
    assert.equal(r.state.userTarget, 22);
  });

  it('without persisted state a restart would stack the offset (why persistence matters)', async () => {
    const r = rig({ external: 19 });
    await r.t.onDeviceState(heat({ deviceTarget: 26 }));
    assert.deepEqual(r.sent, [30]);
  });

  it('writes a HomeKit change that arrives while another write is in flight', async () => {
    const r = rig({ external: 19 });
    const release = r.hold();
    const polling = r.t.onDeviceState(heat());
    const changing = r.t.onUserTargetChanged(24);
    release();
    await Promise.all([polling, changing]);
    assert.deepEqual(r.sent, [26, 28]);
  });

  it('retries a failed write on the next poll and does not adopt the old target', async () => {
    const r = rig({ external: 19 });
    r.failNext();
    await r.t.onDeviceState(heat());
    r.advance(4 * MIN);
    r.push(19);
    await r.t.onDeviceState(heat({ deviceTarget: 22 }));
    assert.deepEqual(r.sent, [26, 26]);
    assert.equal(r.state.userTarget, 22);
  });
});

describe('SetpointCompensator smoothing', () => {
  function stepResponse(callEveryMs: number, forMs: number): number {
    let now = 0;
    const c = new SetpointCompensator({ ...SETTINGS, smoothingMs: 10 * MIN }, () => now);
    c.offset(19, 19); // settled at 0
    let out = 0;
    for (let t = callEveryMs; t <= forMs; t += callEveryMs) {
      now = t;
      out = c.offset(23, 19); // offset steps to 4
    }
    return out;
  }

  it('does not depend on how often it is called', () => {
    const fast = stepResponse(15_000, 30 * MIN);
    const slow = stepResponse(3 * MIN, 30 * MIN);
    assert.ok(Math.abs(fast - slow) < 1e-9, `${fast} vs ${slow}`);
  });

  it('follows a step with the configured time constant', () => {
    assert.ok(stepResponse(15_000, MIN) < 0.5, 'barely moves in the first minute');
    const oneTau = stepResponse(15_000, 10 * MIN);
    assert.ok(Math.abs(oneTau - 4 * (1 - Math.exp(-1))) < 1e-9);
  });
});

describe('releaseCompensation', () => {
  const state = (): CompensationState => ({ userTarget: 22, lastSent: { workMode: HEAT, celsius: 26 } });

  async function run(s: CompensationState, snap: DeviceSnapshot) {
    const sent: number[] = [];
    const done = await releaseCompensation(s, snap, { setTargetTemperature: async (c) => { sent.push(c); } }, silentLog);
    return { done, sent };
  }

  it('restores the user target when the AC is still on the compensated one', async () => {
    assert.deepEqual(await run(state(), heat({ deviceTarget: 26 })), { done: true, sent: [22] });
  });

  it('leaves a target that was changed since alone', async () => {
    assert.deepEqual(await run(state(), heat({ deviceTarget: 24 })), { done: true, sent: [] });
  });

  it('waits while the AC is off', async () => {
    assert.deepEqual(await run(state(), heat({ powerOn: false, deviceTarget: 26 })), { done: false, sent: [] });
  });

  it('keeps the state when the restore fails', async () => {
    const done = await releaseCompensation(
      state(), heat({ deviceTarget: 26 }),
      { setTargetTemperature: async () => { throw new Error('cloud down'); } }, silentLog,
    );
    assert.equal(done, false);
  });
});
