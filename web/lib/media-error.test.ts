import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaErrorMessage } from './media-error.ts';

test('a blocked permission explains how to allow it', () => {
  const msg = mediaErrorMessage(new DOMException('x', 'NotAllowedError'), 'Zylo');
  assert.match(msg, /site settings/);
});

test('a missing device says you can still join', () => {
  const msg = mediaErrorMessage(new DOMException('x', 'NotFoundError'), 'Zylo');
  assert.match(msg, /still join/);
});

test('a busy device names the other app', () => {
  const msg = mediaErrorMessage(new DOMException('x', 'NotReadableError'), 'Zylo');
  assert.match(msg, /in use by another app/);
});

test('anything else falls back to the HTTPS hint, naming the product', () => {
  for (const err of [new Error('boom'), undefined, 'a string']) {
    const msg = mediaErrorMessage(err, 'Zylo');
    assert.match(msg, /HTTPS|localhost/);
    assert.match(msg, /Zylo/);
  }
});

test('room context: a missing device does not say you can still join', () => {
  const msg = mediaErrorMessage(new DOMException('x', 'NotFoundError'), 'Zylo', 'room');
  assert.doesNotMatch(msg, /still join/);
});

test('room context: an unrecognised error does not mention HTTPS or localhost', () => {
  const msg = mediaErrorMessage(new Error('boom'), 'Zylo', 'room');
  assert.doesNotMatch(msg, /HTTPS|localhost/);
  assert.match(msg, /camera|microphone/i);
});
