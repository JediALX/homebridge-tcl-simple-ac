/**
 * Platform-level tests: the opt-in contract, the disable path and an
 * end-to-end run (shortcut push -> receiver -> poll -> compensated write)
 * against a fake TCL cloud. Nothing here touches a real AC.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { describe, it, TestContext } from 'node:test';

import { TclSimpleAcPlatform } from './platform';
import {
  BREEZEIN_REPORTED,
  Characteristic as C,
  FakeAccessory,
  FakeApi,
  FakeLog,
  FakeShadow,
  heaterCooler,
  Service,
  sleep,
  uuid,
} from './testing/harness';
import type { TclThing } from './tcl/api';

const TOKEN = 'a-long-random-token-1234';
const LIVING: TclThing = { deviceId: 'dev-living', nickName: 'Living AC', deviceName: 'Split AC', isOnline: true };
const BEDROOM: TclThing = { deviceId: 'dev-bedroom', nickName: 'Bedroom AC', deviceName: 'Split AC', isOnline: true };
const REPORTED = { ...BREEZEIN_REPORTED, currentTemperature: 23 }; // heat, target 22
const DEBOUNCE_SETTLE_MS = 450;

const acUuid = (thing: TclThing) => uuid.generate(`homebridge-tcl-simple-ac:${thing.deviceId}`);
const SENSOR_UUID = uuid.generate('homebridge-tcl-simple-ac:sensor-poll');

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface LaunchOptions {
  compensation?: unknown;
  things?: TclThing[];
  reported?: Record<string, unknown>;
  cached?: FakeAccessory[];
}

async function launch(t: TestContext, opts: LaunchOptions = {}) {
  const things = opts.things ?? [LIVING];
  const api = new FakeApi();
  const log = new FakeLog();
  const createServer = t.mock.method(http, 'createServer');
  const platform = new TclSimpleAcPlatform(
    log as never,
    { platform: 'TclSimpleAC', username: 'user@example.com', password: 'secret', compensation: opts.compensation },
    api as never,
  );
  for (const cached of opts.cached ?? []) {
    platform.configureAccessory(cached as never);
  }
  const shadow = new FakeShadow(opts.reported ?? REPORTED);
  platform.shadow = shadow as never;
  platform.session = {
    getCloudUrls: async () => ({ deviceUrl: 'https://tcl.invalid' }),
    getApiHeaders: async () => ({}),
  } as never;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === 'https://tcl.invalid/v3/user/get_things') {
      const data = things.map((th) => ({ device_id: th.deviceId, nick_name: th.nickName, device_name: th.deviceName }));
      return new Response(JSON.stringify({ code: 0, data }));
    }
    return realFetch(input, init);
  });

  api.emit('didFinishLaunching');
  t.after(() => { api.emit('shutdown'); });
  for (let i = 0; i < 100 && shadow.getShadowCalls < things.length; i++) {
    await sleep(10);
  }
  await sleep(20); // let the receiver finish binding
  assert.equal(shadow.getShadowCalls, things.length, 'initial poll ran');

  const accessory = (thing: TclThing) =>
    [...api.registered, ...(opts.cached ?? [])].find((a) => a.UUID === acUuid(thing))!;
  return {
    api,
    log,
    platform,
    shadow,
    createServer,
    accessory,
    hc: (thing: TclThing = LIVING) => heaterCooler(accessory(thing)),
    pollAll: () => (platform as unknown as { pollAll(): Promise<void> }).pollAll(),
  };
}

function compensationConfig(port: number, rooms = [{ deviceId: LIVING.deviceId, roomKey: 'living' }]) {
  return { enabled: true, port, bindHost: '127.0.0.1', token: TOKEN, rooms };
}

function push(port: number, readings: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/temperatures`, {
    method: 'POST',
    headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ readings }),
  });
}

describe('opt-in contract', () => {
  for (const [name, compensation] of [
    ['no compensation block', undefined],
    ['enabled: false', { enabled: false, token: TOKEN, rooms: [{ deviceId: LIVING.deviceId, roomKey: 'living' }] }],
  ] as const) {
    it(`${name}: no server, no extra accessory, values and writes as before`, async (t) => {
      const r = await launch(t, { compensation });
      assert.equal(r.createServer.mock.callCount(), 0, 'no port opened');
      assert.deepEqual(r.api.registered.map((a) => a.UUID), [acUuid(LIVING)]);
      assert.equal(r.hc().getCharacteristic(C.HeatingThresholdTemperature).value, 22);
      assert.equal(r.hc().getCharacteristic(C.CurrentTemperature).value, 23);

      r.hc().getCharacteristic(C.HeatingThresholdTemperature).setValue(24);
      await sleep(DEBOUNCE_SETTLE_MS);
      assert.deepEqual(r.shadow.published, [{ targetTemperature: 24 }]);
      assert.equal(r.api.updates, 0, 'accessory cache untouched');
      assert.equal(r.log.lines.filter((l) => /compensation|temperature receiver/i.test(l.msg)).length, 0);
    });
  }
});

describe('invalid compensation config', () => {
  it('warns once, keeps the Sensor poll accessory, and TCL control works as before', async (t) => {
    const r = await launch(t, { compensation: { enabled: true, token: 'short', rooms: [] } });
    const warnings = r.log.at('warn');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /compensation is OFF/);
    assert.equal(r.createServer.mock.callCount(), 0);
    assert.ok(r.api.registered.some((a) => a.UUID === SENSOR_UUID), 'automation trigger survives a config typo');

    r.hc().getCharacteristic(C.HeatingThresholdTemperature).setValue(24);
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.published, [{ targetTemperature: 24 }]);
  });
});

describe('compensation end to end', () => {
  it('a shortcut push shows the room temperature and the next poll sends a compensated target', async (t) => {
    const port = await freePort();
    const r = await launch(t, { compensation: compensationConfig(port) });
    assert.equal(r.createServer.mock.callCount(), 1, 'the spy sees the receiver (so the opt-in check is real)');
    const sensor = r.api.registered.find((a) => a.UUID === SENSOR_UUID)!;
    assert.ok(sensor, 'Sensor poll accessory registered');
    assert.equal(sensor.getService(Service.Switch)!.getCharacteristic(C.On).value, true, 'pulsed at start');
    assert.deepEqual(r.shadow.published, [], 'no reading yet: waits instead of writing');

    assert.equal((await push(port, { living: '19,0 °C' })).status, 204);
    await r.pollAll();
    assert.equal(r.hc().getCharacteristic(C.CurrentTemperature).value, 19);
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.published, [{ targetTemperature: 26 }]); // 22 + (23 - 19)
    assert.equal(r.hc().getCharacteristic(C.HeatingThresholdTemperature).value, 22);
    assert.equal(r.hc().getCharacteristic(C.CoolingThresholdTemperature).value, 22);
    assert.ok(r.log.at('info').some((m) => m === '[Living AC] compensation: user=22 internal=23 external=19 -> sent 26'));
    assert.deepEqual(r.accessory(LIVING).context.compensation, { userTarget: 22, lastSent: { workMode: 4, celsius: 26 } });
  });

  it('a HomeKit change is shown as-is and sent compensated', async (t) => {
    const port = await freePort();
    const r = await launch(t, { compensation: compensationConfig(port) });
    await push(port, { living: 19 });
    await r.pollAll();
    await sleep(DEBOUNCE_SETTLE_MS);
    r.hc().getCharacteristic(C.HeatingThresholdTemperature).setValue(23);
    assert.equal(r.hc().getCharacteristic(C.HeatingThresholdTemperature).value, 23);
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.published, [{ targetTemperature: 26 }, { targetTemperature: 27 }]);
    assert.equal(r.hc().getCharacteristic(C.HeatingThresholdTemperature).value, 23);
  });

  it('logs every push at info when logReadings is on', async (t) => {
    const port = await freePort();
    const r = await launch(t, { compensation: { ...compensationConfig(port), logReadings: true } });
    await push(port, { living: 19 });
    await push(port, { living: '19,5 °C' });
    assert.ok(r.log.at('info').includes('temperature push: living 19.5 °C'));
  });

  it('leaves unmapped devices alone while others compensate', async (t) => {
    const port = await freePort();
    const r = await launch(t, { compensation: compensationConfig(port), things: [LIVING, BEDROOM] });
    await push(port, { living: 19 });
    await r.pollAll();
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.writes, [{ deviceId: LIVING.deviceId, desired: { targetTemperature: 26 } }]);
    assert.equal(r.hc(BEDROOM).getCharacteristic(C.CurrentTemperature).value, 23);
    assert.equal(r.accessory(BEDROOM).context.compensation, undefined);
  });

  it('resumes from persisted state after a restart without stacking the offset', async (t) => {
    const port = await freePort();
    const cached = new FakeAccessory(LIVING.nickName, acUuid(LIVING));
    cached.context = { deviceId: LIVING.deviceId, compensation: { userTarget: 22, lastSent: { workMode: 4, celsius: 26 } } };
    const r = await launch(t, { compensation: compensationConfig(port), cached: [cached], reported: { ...REPORTED, targetTemperature: 26 } });
    assert.equal(r.hc().getCharacteristic(C.HeatingThresholdTemperature).value, 22);
    await push(port, { living: 19 });
    await r.pollAll();
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.published, []);
  });

  it('keeps TCL control working when the receiver port is taken', async (t) => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => blocker.close());
    const port = (blocker.address() as net.AddressInfo).port;
    const r = await launch(t, { compensation: compensationConfig(port) });
    assert.ok(r.log.at('warn').some((m) => m.includes('already in use')));
    assert.deepEqual(r.log.at('error'), []);
    assert.equal(r.hc().getCharacteristic(C.HeatingThresholdTemperature).value, 22);
  });
});

describe('disabling compensation', () => {
  it('restores the user target, clears the stored state and removes the Sensor poll accessory', async (t) => {
    const cached = new FakeAccessory(LIVING.nickName, acUuid(LIVING));
    cached.context = { deviceId: LIVING.deviceId, compensation: { userTarget: 22, lastSent: { workMode: 4, celsius: 26 } } };
    const sensor = new FakeAccessory('Sensor poll', SENSOR_UUID);
    const r = await launch(t, { cached: [cached, sensor], reported: { ...REPORTED, targetTemperature: 26 } });
    assert.deepEqual(r.api.unregistered.map((a) => a.UUID), [SENSOR_UUID]);
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.published, [{ targetTemperature: 22 }]);
    assert.equal(cached.context.compensation, undefined);
    assert.ok(r.api.updates > 0);
  });

  it('leaves a target the user changed since alone', async (t) => {
    const cached = new FakeAccessory(LIVING.nickName, acUuid(LIVING));
    cached.context = { deviceId: LIVING.deviceId, compensation: { userTarget: 22, lastSent: { workMode: 4, celsius: 26 } } };
    const r = await launch(t, { cached: [cached], reported: { ...REPORTED, targetTemperature: 24 } });
    await sleep(DEBOUNCE_SETTLE_MS);
    assert.deepEqual(r.shadow.published, []);
    assert.equal(cached.context.compensation, undefined);
  });
});
