const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roomHarness, settle, waitForEvent } = require('./helpers');

test('an explicit leave evicts the participant from LiveKit', async (t) => {
  const { meetingId, livekit, join } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');

  p1.emit('meeting:leave');
  await settle();

  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);
});

test('a dropped connection is evicted when its grace period runs out, not before', async (t) => {
  const { meetingId, livekit, join } = await roomHarness(t, { graceMs: 60 });
  await join('host');
  const p1 = await join('p1');

  p1.disconnect();
  await settle(15);
  assert.deepEqual(livekit.callsTo('evict'), []);

  await settle(120);
  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);
});

test('coming back inside the grace period evicts nobody', async (t) => {
  const { livekit, join } = await roomHarness(t, { graceMs: 500 });
  await join('host');
  const p1 = await join('p1');

  p1.disconnect();
  await settle(20);
  await join('p1');
  await settle(600);

  assert.deepEqual(livekit.callsTo('evict'), []);
});

test('a second tab taking the seat over evicts nobody', async (t) => {
  const { meetingId, livekit, join, connect } = await roomHarness(t);
  await join('host');
  const first = await join('p1');
  const replaced = waitForEvent(first, 'meeting:replaced');
  const second = connect('p1');
  const admitted = waitForEvent(second, 'meeting:admitted');
  second.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, admitted]);

  first.disconnect();
  await settle(120);

  assert.deepEqual(livekit.callsTo('evict'), []);
});
