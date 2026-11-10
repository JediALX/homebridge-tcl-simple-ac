import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeLog } from '../testing/harness';
import { parseCompensationConfig } from './config';
import { PushMonitor, SensorPollTrigger } from './sensorPoll';

const RANGE = { minSetpoint: 16, maxSetpoint: 31 };
const VALID = {
  enabled: true,
  token: 'a-long-random-token-1234',
  rooms: [{ deviceId: 'dev-living', roomKey: 'living' }],
};

function parse(raw: unknown) {
  const log = new FakeLog();
  return { result: parseCompensationConfig(raw, RANGE, log), warnings: log.at('warn') };
}

describe('parseCompensationConfig', () => {
  it('is off, silently, when the block is missing or not enabled', () => {
    for (const raw of [undefined, null, {}, { enabled: false, token: 'x' }, { enabled: 'true' }, 'yes']) {
      assert.deepEqual(parse(raw), { result: { status: 'off' }, warnings: [] });
    }
  });

  it('applies the documented defaults', () => {
    const { result, warnings } = parse(VALID);
    assert.deepEqual(warnings, []);
    assert.equal(result.status, 'on');
    if (result.status !== 'on') return;
    assert.equal(result.port, 18581);
    assert.equal(result.bindHost, undefined);
    assert.equal(result.sensorPollIntervalMs, 180_000);
    assert.equal(result.logReadings, false);
    assert.deepEqual([...result.rooms], [['dev-living', 'living']]);
    assert.deepEqual(result.settings, {
      minSetpoint: 16,
      maxSetpoint: 31,
      step: 1,
      maxOffset: 5,
      smoothingMs: 600_000,
      minChangeIntervalMs: 180_000,
      staleAfterMs: 600_000,
      echoGraceMs: 90_000,
    });
  });

  it('turns the feature off with one warning on bad values, and never throws', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ token: undefined }, /token/],
      [{ token: 'short' }, /token/],
      [{ port: 80 }, /port/],
      [{ port: '18581' }, /port/],
      [{ port: 18581.5 }, /port/],
      [{ maxOffset: 50 }, /maxOffset/],
      [{ smoothingMinutes: -1 }, /smoothingMinutes/],
      [{ sensorPollIntervalSeconds: 600, staleAfterSeconds: 600 }, /staleAfterSeconds/],
      [{ rooms: [] }, /rooms/],
      [{ rooms: [{ deviceId: 'a' }] }, /rooms\[0\]/],
      [{ rooms: [{ deviceId: 'a', roomKey: 'x' }, { deviceId: 'a', roomKey: 'y' }] }, /more than once/],
      [{ rooms: 'living' }, /rooms/],
      [{ bindHost: 42 }, /bindHost/],
      [{ logReadings: 'yes' }, /logReadings/],
    ];
    for (const [override, expected] of cases) {
      const { result, warnings } = parse({ ...VALID, ...override });
      assert.deepEqual(result, { status: 'invalid' }, JSON.stringify(override));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], expected);
      assert.match(warnings[0], /TCL control is unaffected/);
    }
  });

  it('turns per-push logging on with logReadings: true', () => {
    const { result } = parse({ ...VALID, logReadings: true });
    assert.equal(result.status === 'on' && result.logReadings, true);
  });

  it('accepts an empty bindHost as all interfaces and trims values', () => {
    const { result } = parse({ ...VALID, bindHost: ' ', rooms: [{ deviceId: ' dev-living ', roomKey: ' living ' }] });
    assert.equal(result.status, 'on');
    if (result.status !== 'on') return;
    assert.equal(result.bindHost, undefined);
    assert.deepEqual([...result.rooms], [['dev-living', 'living']]);
  });
});

describe('SensorPollTrigger', () => {
  it('pulses at start and then on every interval, and stops', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const pulses: number[] = [];
    const trigger = new SensorPollTrigger({ pulse: (ms) => pulses.push(ms) }, 180_000, 3_000);
    trigger.start();
    t.mock.timers.tick(360_000);
    assert.deepEqual(pulses, [3_000, 3_000, 3_000]);
    trigger.stop();
    t.mock.timers.tick(360_000);
    assert.equal(pulses.length, 3);
  });
});

describe('PushMonitor', () => {
  function monitor() {
    let now = 0;
    let last: number | undefined;
    const readings = new Map<string, number>();
    const log = new FakeLog();
    const m = new PushMonitor(
      { lastPushAt: () => last, reading: (room) => readings.get(room) },
      ['living', 'bedroom'],
      180_000,
      log,
      () => now,
    );
    return {
      m,
      log,
      at(ms: number) { now = ms; },
      push(...rooms: string[]) { last = now; rooms.forEach((r) => readings.set(r, 20)); },
    };
  }

  it('warns once when no push ever arrives', () => {
    const r = monitor();
    r.at(300_000); r.m.check();
    assert.deepEqual(r.log.lines, []);
    r.at(400_000); r.m.check();
    r.at(800_000); r.m.check();
    assert.equal(r.log.at('warn').length, 1);
    assert.match(r.log.at('warn')[0], /no temperature pushes/);
  });

  it('logs once when pushes stop and once when they resume', () => {
    const r = monitor();
    r.push('living', 'bedroom');
    r.at(400_000); r.m.check();
    r.at(500_000); r.m.check();
    assert.equal(r.log.at('info').length, 1);
    assert.match(r.log.at('info')[0], /stopped/);
    r.push('living', 'bedroom'); r.m.check();
    r.at(510_000); r.m.check();
    assert.deepEqual(r.log.at('info').slice(1), ['temperature pushes resumed']);
  });

  it('warns once about a configured room that never appears in a push', () => {
    const r = monitor();
    r.at(350_000); r.push('living'); r.m.check();
    r.at(400_000); r.push('living'); r.m.check();
    assert.deepEqual(r.log.at('warn'), ['room "bedroom" is configured but no shortcut push has included it']);
  });
});
