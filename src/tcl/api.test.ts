import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSplitAc, TclThing } from './api';
import { normalizeIotEndpoint } from './shadow';

function thing(overrides: Partial<TclThing>): TclThing {
  return { deviceId: 'x', nickName: 'AC', isOnline: true, ...overrides };
}

describe('isSplitAc', () => {
  it('matches by deviceType, including numbered variants', () => {
    assert.equal(isSplitAc(thing({ deviceType: 'Split AC' })), true);
    assert.equal(isSplitAc(thing({ deviceType: 'Split AC-2' })), true);
    assert.equal(isSplitAc(thing({ deviceType: 'Split AC Fresh air' })), true);
    assert.equal(isSplitAc(thing({ deviceType: 'Portable AC' })), false);
    assert.equal(isSplitAc(thing({ deviceType: 'Window AC', deviceName: 'Split AC' })), false);
  });

  it('falls back to deviceName when deviceType is empty (BreezeIN 2.0 firmware)', () => {
    assert.equal(isSplitAc(thing({ deviceType: '', deviceName: 'Split AC', category: 'AC' })), true);
    assert.equal(isSplitAc(thing({ deviceType: '', deviceName: 'Portable AC', category: 'AC' })), false);
  });

  it('falls back to category when both type and name are unhelpful', () => {
    assert.equal(isSplitAc(thing({ deviceType: '', deviceName: '', category: 'AC' })), true);
    assert.equal(isSplitAc(thing({ deviceType: '', deviceName: '', category: 'Dehumidifier' })), false);
  });
});

describe('normalizeIotEndpoint', () => {
  it('converts MQTT-style endpoints to bare https hosts', () => {
    assert.equal(
      normalizeIotEndpoint('wss://a1bc-ats.iot.eu-central-1.amazonaws.com/mqtt'),
      'https://a1bc-ats.iot.eu-central-1.amazonaws.com',
    );
    assert.equal(
      normalizeIotEndpoint('a1bc-ats.iot.eu-central-1.amazonaws.com:443'),
      'https://a1bc-ats.iot.eu-central-1.amazonaws.com',
    );
    assert.equal(
      normalizeIotEndpoint('https://a1bc-ats.iot.eu-central-1.amazonaws.com'),
      'https://a1bc-ats.iot.eu-central-1.amazonaws.com',
    );
  });
});
