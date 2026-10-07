import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageView, presentingBanner, screenDeniedMessage, screenStartErrorMessage } from './screen-share.ts';

const people = [
  { userId: 'u1', name: 'Priya' },
  { userId: 'u2', name: 'Raj' },
];

test('nobody presenting keeps the grid', () => {
  assert.deepEqual(stageView(null, 'u1', people), { mode: 'grid' });
});

test('someone else presenting fills the stage with their screen and name', () => {
  assert.deepEqual(stageView('u2', 'u1', people), {
    mode: 'presenting',
    sharerUserId: 'u2',
    sharerName: 'Raj',
    isSelf: false,
  });
});

test('presenting yourself is marked as self', () => {
  const view = stageView('u1', 'u1', people);
  assert.equal(view.mode, 'presenting');
  assert.equal((view as { isSelf: boolean }).isSelf, true);
});

test('a presenter missing from the roster falls back to the grid', () => {
  assert.deepEqual(stageView('u9', 'u1', people), { mode: 'grid' });
});

test('the banner names the presenter, or says it is you', () => {
  const other = stageView('u2', 'u1', people);
  assert.equal(other.mode, 'presenting');
  const otherMsg = presentingBanner(other as Extract<typeof other, { mode: 'presenting' }>, 'ZyloLive');
  assert.match(otherMsg, /^ZyloLive/);
  assert.match(otherMsg, /Raj is presenting/);

  const self = stageView('u1', 'u1', people);
  assert.equal(self.mode, 'presenting');
  const selfMsg = presentingBanner(self as Extract<typeof self, { mode: 'presenting' }>, 'ZyloLive');
  assert.match(selfMsg, /You are presenting/);
});

test('a busy denial names who is presenting', () => {
  const msg = screenDeniedMessage({ reason: 'busy', sharerName: 'Priya' }, 'ZyloLive');
  assert.match(msg, /ZyloLive is in use by Priya/);
});

test('a host-only denial says only the host can present', () => {
  const msg = screenDeniedMessage({ reason: 'host_only' }, 'ZyloLive');
  assert.match(msg, /Only the host can use ZyloLive/);
});

test('an unavailable denial asks to try again', () => {
  const msg = screenDeniedMessage({ reason: 'unavailable' }, 'ZyloLive');
  assert.match(msg, /Try again/);
});

test('a closed or blocked picker points at the system permission', () => {
  const msg = screenStartErrorMessage(new DOMException('x', 'NotAllowedError'), 'ZyloLive');
  assert.match(msg, /screen recording/);
});

test('a browser without screen capture is told so', () => {
  const deviceUnsupported = Object.assign(new Error('x'), { name: 'DeviceUnsupportedError' });
  assert.match(screenStartErrorMessage(deviceUnsupported, 'ZyloLive'), /available in this browser/);

  const notSupported = new DOMException('x', 'NotSupportedError');
  assert.match(screenStartErrorMessage(notSupported, 'ZyloLive'), /available in this browser/);
});

test('any other failure gets a generic line naming ZyloLive', () => {
  for (const err of [new Error('boom'), undefined, 'a string']) {
    const msg = screenStartErrorMessage(err, 'ZyloLive');
    assert.match(msg, /share your screen/);
    assert.match(msg, /ZyloLive/);
  }
});
