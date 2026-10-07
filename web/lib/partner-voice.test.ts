import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partnerVolume } from './partner-voice.ts';

test('low plays quiet and unmuted when nobody is speaking', () => {
  assert.deepEqual(partnerVolume('low', false), { volume: 0.25, muted: false });
});

test('full plays at full volume and unmuted when nobody is speaking', () => {
  assert.deepEqual(partnerVolume('full', false), { volume: 1, muted: false });
});

test('off is always muted, even at rest', () => {
  const { muted } = partnerVolume('off', false);
  assert.equal(muted, true);
});

test('speaking mutes every setting, including full', () => {
  assert.equal(partnerVolume('low', true).muted, true);
  assert.equal(partnerVolume('full', true).muted, true);
  assert.equal(partnerVolume('off', true).muted, true);
});

test('the volume level itself only depends on the setting, not on speaking', () => {
  assert.equal(partnerVolume('full', true).volume, 1);
  assert.equal(partnerVolume('low', true).volume, 0.25);
});
