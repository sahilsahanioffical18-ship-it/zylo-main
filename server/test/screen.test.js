const test = require('node:test');
const assert = require('node:assert/strict');
const {
  roomHarness,
  collect,
  settle,
  shareScreen,
  waitForEvent,
  setupTestDb,
  startRoom,
  seat,
  takeOverSeat,
} = require('./helpers');

test('without LiveKit configured a ZyloLive request is answered unavailable', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await startRoom(db); // livekit defaults to null
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await settle();
    await server.close();
    await db.close();
  });

  const p1 = await seat(server.url, 'p1', meetingId);
  clients.push(p1);
  const denied = collect(p1, 'screen:denied');
  p1.emit('screen:request');
  await settle();

  assert.deepEqual(denied, [{ reason: 'unavailable' }]);
  assert.equal(await store.screenSharer(meetingId), null);
});

test('two people press ZyloLive at the same instant: exactly one is granted', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');
  const p2 = await join('p2');

  const granted1 = collect(p1, 'screen:granted');
  const denied1 = collect(p1, 'screen:denied');
  const granted2 = collect(p2, 'screen:granted');
  const denied2 = collect(p2, 'screen:denied');

  p1.emit('screen:request');
  p2.emit('screen:request');
  await settle();

  const p1Won = granted1.length === 1;
  const p2Won = granted2.length === 1;
  assert.equal([p1Won, p2Won].filter(Boolean).length, 1);

  const winnerUserId = p1Won ? 'p1' : 'p2';
  const loserDenied = p1Won ? denied2 : denied1;
  const winnerName = (await store.seatFor(meetingId, winnerUserId)).name;
  assert.deepEqual(loserDenied, [{ reason: 'busy', sharerName: winnerName }]);
  assert.equal(livekit.callsTo('grantScreenShare').length, 1);
});

test('with policy host_only a participant is denied and the host is granted', async (t) => {
  const { meetingId, livekit, join } = await roomHarness(t, { screenSharePolicy: 'host_only' });
  const host = await join('host');
  const p1 = await join('p1');

  const denied = collect(p1, 'screen:denied');
  p1.emit('screen:request');
  await settle();
  assert.deepEqual(denied, [{ reason: 'host_only' }]);
  assert.equal(livekit.callsTo('grantScreenShare').length, 0);

  await shareScreen(host);
  assert.deepEqual(livekit.callsTo('grantScreenShare'), [[meetingId, 'host']]);
});

test('a waiting user cannot take ZyloLive', async (t) => {
  const { meetingId, livekit, connect, join, store } = await roomHarness(t, { maxParticipants: 2 });
  await join('host');
  await join('p1');

  const p2 = connect('p2');
  const waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await waiting;

  const granted = collect(p2, 'screen:granted');
  const denied = collect(p2, 'screen:denied');
  t.mock.method(console, 'error');
  p2.emit('screen:request');
  await settle();

  assert.deepEqual(granted, []);
  assert.deepEqual(denied, []);
  assert.equal(await store.screenSharer(meetingId), null);
  assert.equal(livekit.callsTo('grantScreenShare').length, 0);
  assert.equal(console.error.mock.callCount(), 0);
});

test('a socket the seat no longer points at cannot take ZyloLive', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');

  // Repoint the seat to a synthetic socket without going through admit(), so
  // p1's real socket keeps socket.data.meetingId set even though the seat no
  // longer points at it. Same trick as room.test.js's chat test.
  await takeOverSeat(store, meetingId, 'p1', 'synthetic-other-tab');

  const granted = collect(p1, 'screen:granted');
  p1.emit('screen:request');
  await settle();

  assert.deepEqual(granted, []);
  assert.equal(await store.screenSharer(meetingId), null);
  assert.equal(livekit.callsTo('grantScreenShare').length, 0);
});

test('the sharer stopping releases the lock, revokes the permission and tells the room', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  await shareScreen(p1);
  const states = collect(host, 'screen:state');
  p1.emit('screen:stop');
  await settle();

  assert.deepEqual(states, [{ sharerUserId: null }]);
  assert.equal(await store.screenSharer(meetingId), null);
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);
});

test('someone other than the sharer cannot stop the share', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');
  const p2 = await join('p2');

  await shareScreen(p1);
  p2.emit('screen:stop');
  await settle();

  assert.equal((await store.screenSharer(meetingId))?.userId, 'p1');
  assert.equal(livekit.callsTo('revokeScreenShare').length, 0);
});

test('the sharer closing their tab frees the lock at once, not at grace expiry', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  await shareScreen(p1);
  const states = collect(host, 'screen:state');
  p1.disconnect();
  await settle(20); // well inside the 60ms grace window

  assert.equal(await store.hasSeat(meetingId, 'p1'), true);
  assert.deepEqual(states, [{ sharerUserId: null }]);
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);
});

test("a second tab taking the seat over ends the first tab's share", async (t) => {
  const { meetingId, livekit, connect, join } = await roomHarness(t);
  const host = await join('host');
  const first = await join('p1');

  await shareScreen(first);
  const hostStates = collect(host, 'screen:state');

  const second = connect('p1');
  const secondStates = collect(second, 'screen:state'); // before its join
  const replaced = waitForEvent(first, 'meeting:replaced');
  const admitted = waitForEvent(second, 'meeting:admitted');
  second.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, admitted]);
  await settle();

  assert.deepEqual(hostStates, [{ sharerUserId: null }]);
  assert.deepEqual(secondStates, [{ sharerUserId: null }]); // the new page starts out not presenting
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);
});

test('someone admitted mid-presentation is told who is presenting', async (t) => {
  const { meetingId, connect, join } = await roomHarness(t);
  const host = await join('host');
  await shareScreen(host);

  const p1 = connect('p1');
  const states = collect(p1, 'screen:state');
  const admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await admitted;
  await settle();

  assert.deepEqual(states, [{ sharerUserId: 'host' }]);
});

test('a grant LiveKit refuses is denied, and frees the lock for the next person', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');
  const p2 = await join('p2');

  const recordingGrant = livekit.grantScreenShare;
  livekit.grantScreenShare = async () => {
    throw new Error('fetch failed');
  };

  const denied = collect(p1, 'screen:denied');
  p1.emit('screen:request');
  await settle();
  assert.deepEqual(denied, [{ reason: 'unavailable' }]);
  assert.equal(await store.screenSharer(meetingId), null);
  // I3: the grant may have applied at LiveKit before it rejected (a timeout, a 5xx
  // after application), so the catch revokes too, not just releases the lock.
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);

  livekit.grantScreenShare = recordingGrant;
  await shareScreen(p2);
  assert.equal((await store.screenSharer(meetingId))?.userId, 'p2');
});

test('a lock released while its grant is in flight is revoked again and never granted', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');

  livekit.grantScreenShare = async (mtgId, userId) => {
    livekit.calls.push(['grantScreenShare', mtgId, userId]);
    // What a host stop, a policy switch, or the tab closing does mid-grant.
    await store.releaseScreenLock(mtgId, (await store.screenSharer(mtgId)).socketId);
  };

  const granted = collect(p1, 'screen:granted');
  p1.emit('screen:request');
  await settle();

  assert.deepEqual(granted, []);
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);
});
