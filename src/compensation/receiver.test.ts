import assert from 'node:assert/strict';
import os from 'node:os';
import { after, before, describe, it } from 'node:test';

import { FakeLog } from '../testing/harness';
import { HomeKitTemperatureReceiver, parseCelsius, RoomSource } from './receiver';

const TOKEN = 'test-token-0123456789';

describe('parseCelsius', () => {
  it('reads numbers and locale-formatted text', () => {
    assert.equal(parseCelsius(21.4), 21.4);
    assert.equal(parseCelsius('21,5 °C'), 21.5);
    assert.equal(parseCelsius('20.9°C'), 20.9);
    assert.equal(parseCelsius('-3,0 °C'), -3);
  });

  it('rejects Fahrenheit-looking values and garbage', () => {
    assert.equal(parseCelsius(72), undefined);
    assert.equal(parseCelsius('72 °F'), undefined);
    assert.equal(parseCelsius('warm'), undefined);
    assert.equal(parseCelsius(''), undefined);
    assert.equal(parseCelsius(null), undefined);
    assert.equal(parseCelsius(Number.NaN), undefined);
    assert.equal(parseCelsius({ value: 21 }), undefined);
  });
});

describe('HomeKitTemperatureReceiver', () => {
  const log = new FakeLog();
  const receiver = new HomeKitTemperatureReceiver(
    { port: 0, bindHost: '127.0.0.1', token: TOKEN, rooms: ['living', 'bedroom'] },
    log,
  );
  let url: string;

  before(async () => {
    assert.equal(await receiver.start(), true);
    url = `http://127.0.0.1:${receiver.port()}/temperatures`;
  });
  after(() => receiver.stop());

  const post = (body: string, token = TOKEN, path = url) =>
    fetch(path, { method: 'POST', headers: { 'x-token': token, 'content-type': 'application/json' }, body });

  it('stores readings from a valid push (the README curl)', async () => {
    const res = await post('{"readings":{"living":"21,4 °C","bedroom":20.9}}');
    assert.equal(res.status, 204);
    assert.equal(receiver.reading('living')?.celsius, 21.4);
    assert.equal(new RoomSource(receiver, 'bedroom').latest()?.celsius, 20.9);
    assert.ok(receiver.lastPushAt());
  });

  it('answers 404 to a wrong or missing token, a wrong path or a GET', async () => {
    assert.equal((await post('{"readings":{"living":30}}', 'wrong')).status, 404);
    assert.equal((await post('{"readings":{"living":30}}', `${TOKEN}x`)).status, 404);
    assert.equal((await post('{"readings":{"living":30}}', TOKEN, `${url}/x`)).status, 404);
    assert.equal((await fetch(url, { headers: { 'x-token': TOKEN } })).status, 404);
    assert.equal(receiver.reading('living')?.celsius, 21.4);
  });

  it('keeps the valid rooms of a partial push and reports unknown room keys once', async () => {
    const res = await post('{"readings":{"living":"22 °C","bedroom":"n/a","livng":20}}');
    assert.equal(res.status, 204);
    assert.equal(receiver.reading('living')?.celsius, 22);
    assert.equal(receiver.reading('bedroom')?.celsius, 20.9);
    assert.equal(receiver.reading('livng'), undefined);
    await post('{"readings":{"livng":20,"living":22}}');
    assert.equal(log.at('warn').filter((m) => m.includes('"livng"')).length, 1);
  });

  it('answers 400 to invalid JSON or nothing usable', async () => {
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('{"readings":{"living":"warm"}}')).status, 400);
    assert.equal((await post('{"something":"else"}')).status, 400);
  });

  it('drops an oversize body', async () => {
    const big = JSON.stringify({ readings: { living: 30 }, pad: 'x'.repeat(10_000) });
    const res = await post(big).catch(() => undefined);
    assert.ok(res === undefined || res.status !== 204);
    assert.equal(receiver.reading('living')?.celsius, 22);
  });

  it('logs the exact URL to put in the shortcut', () => {
    assert.deepEqual(log.at('info'), [`temperature receiver ready. Shortcut URL: ${url}`]);
  });

  it('lists every external IPv4 address when listening on all interfaces', (t) => {
    t.mock.method(os, 'networkInterfaces', () => ({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    }));
    const anyHost = new HomeKitTemperatureReceiver({ port: 18581, token: TOKEN, rooms: [] }, new FakeLog());
    assert.deepEqual(anyHost.shortcutUrls(), [
      'http://192.168.1.20:18581/temperatures',
      'http://172.17.0.1:18581/temperatures',
    ]);
  });

  it('logs instead of throwing when the port is already in use', async () => {
    const clashLog = new FakeLog();
    const clash = new HomeKitTemperatureReceiver(
      { port: receiver.port()!, bindHost: '127.0.0.1', token: TOKEN, rooms: ['living'] },
      clashLog,
    );
    assert.equal(await clash.start(), false);
    assert.match(clashLog.at('warn')[0], /already in use/);
    await clash.stop();
  });
});
