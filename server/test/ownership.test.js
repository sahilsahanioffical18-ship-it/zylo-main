const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roomHarness, waitForEvent, collect, settle } = require('./helpers');

// A new tab takes the seat over. The old tab is told it was replaced, but its socket
// may stay open (and on another server its hint of a meeting is never cleared), so
// what it sends next must not act through a seat it no longer holds.
async function secondTab(connect, meetingId, userId) {
  const tab = connect(userId);
  const admitted = waitForEvent(tab, 'meeting:admitted');
  tab.emit('meeting:join-request', { meetingId });
  await admitted;
  return tab;
}

test("a replaced tab's leave does not free the new tab's seat", async (t) => {
  const { connect, join, store, meetingId } = await roomHarness(t);
  await join('host');
  const tabA = await join('p1');
  const tabB = await secondTab(connect, meetingId, 'p1');
  tabA.emit('meeting:leave');
  await settle(150);
  assert.equal(await store.seatSocketId(meetingId, 'p1'), tabB.id);
});

test('a replaced host tab has no host powers', async (t) => {
  const { connect, join, livekit, meetingId } = await roomHarness(t);
  const tabA = await join('host');
  await join('p1');
  await secondTab(connect, meetingId, 'host');
  const forbidden = collect(tabA, 'error:forbidden');
  tabA.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(forbidden.length, 1);
  assert.equal(livekit.callsTo('muteMic').length, 0);
});

test('an admitted person gets the roster straight after being admitted', async (t) => {
  const { connect, join, meetingId } = await roomHarness(t);
  await join('host');
  const client = connect('p1');
  const events = [];
  client.on('meeting:admitted', () => events.push('admitted'));
  client.on('room:presence', ({ people }) => events.push(`presence:${people.length}`));
  client.emit('meeting:join-request', { meetingId });
  await settle(200);
  assert.equal(events[0], 'admitted');
  assert.equal(events[1], 'presence:2');
});
