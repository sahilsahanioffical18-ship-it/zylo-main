const test = require('node:test');
const assert = require('node:assert/strict');
const {
  roomHarness,
  collect,
  settle,
  shareScreen,
  waitForEvent,
  setupTestDb,
  recordingLivekit,
  startRoom,
  connectClient,
  seat,
} = require('./helpers');

// Pauses one specific db.query call (matched by exact text and first param) until
// release() is called, so a race between two in-flight handlers is deterministic,
// not timing-based. Inactive until arm(): a setup join for the same user must pass
// straight through, or the gate would fire on the wrong call and never resolve.
function gateQuery(db, text, param) {
  let active = false;
  let started = false;
  let notifyStarted;
  const startedPromise = new Promise((resolve) => { notifyStarted = resolve; });
  let releaseGate;
  const gatePromise = new Promise((resolve) => { releaseGate = resolve; });
  const gated = {
    query: async (queryText, params) => {
      if (active && !started && queryText === text && params?.[0] === param) {
        started = true;
        notifyStarted();
        await gatePromise;
      }
      return db.query(queryText, params);
    },
    close: db.close,
  };
  return { db: gated, arm: () => { active = true; }, paused: startedPromise, release: () => releaseGate() };
}

test('a participant sending any host:* event is forbidden and changes nothing', async (t) => {
  const { db, meetingId, livekit, connect, join, store } = await roomHarness(t);
  await join('host');
  const p1 = await join('p1');
  const p2 = await join('p2');
  await shareScreen(p2);

  const baselineCalls = livekit.calls.length;
  const forbidden = collect(p1, 'error:forbidden');
  const attempts = [
    ['host:kick', { userId: 'p2' }],
    ['host:mute', { userId: 'p2' }],
    ['host:stop-share', { userId: 'p2' }],
    ['host:set-screen-policy', { policy: 'host_only' }],
    ['host:end-meeting', {}],
  ];
  for (const [n, [event, payload]] of attempts.entries()) {
    p1.emit(event, payload);
    await settle();
    assert.equal(forbidden.length, n + 1, `${event} was not refused`);
  }

  assert.equal(livekit.calls.length, baselineCalls);
  assert.equal((await store.screenSharer(meetingId))?.userId, 'p2');
  assert.equal(await store.hasSeat(meetingId, 'p2'), true);

  const { rows } = await db.query('SELECT ended_at, screen_share_policy FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ended_at, null);
  assert.equal(rows[0].screen_share_policy, 'anyone');

  const { rows: p2rows } = await db.query(
    'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, 'p2'],
  );
  assert.equal(p2rows[0].removed_at, null);

  const p3 = connect('p3');
  const waiting = waitForEvent(p3, 'meeting:waiting');
  p3.emit('meeting:join-request', { meetingId });
  await waiting;
  const p3Forbidden = waitForEvent(p3, 'error:forbidden');
  p3.emit('host:end-meeting', {});
  await p3Forbidden;
});

test('the host stopping a ZyloLive share ends it and revokes it', async (t) => {
  const { meetingId, livekit, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  await shareScreen(p1);
  const states = collect(p1, 'screen:state');
  host.emit('host:stop-share', { userId: 'p1' });
  await settle();

  assert.deepEqual(states, [{ sharerUserId: null }]);
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);
});

test("a stop aimed at someone who is no longer sharing ends nobody else's share", async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  const host = await join('host');
  await join('p1');
  const p2 = await join('p2');

  await shareScreen(p2);
  host.emit('host:stop-share', { userId: 'p1' });
  await settle();

  assert.equal((await store.screenSharer(meetingId))?.userId, 'p2');
  assert.equal(livekit.callsTo('revokeScreenShare').length, 0);
});

test("switching ZyloLive to host_only ends a participant's share and is saved", async (t) => {
  const { db, meetingId, livekit, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  await shareScreen(p1);
  const settings = collect(p1, 'meeting:settings');
  const states = collect(p1, 'screen:state');
  host.emit('host:set-screen-policy', { policy: 'host_only' });
  await settle();

  assert.deepEqual(settings, [{ admission: 'auto', screenSharePolicy: 'host_only', aiEnabled: true, aiNudges: false }]);
  assert.deepEqual(states, [{ sharerUserId: null }]);
  assert.deepEqual(livekit.callsTo('revokeScreenShare'), [[meetingId, 'p1']]);

  const { rows } = await db.query('SELECT screen_share_policy FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].screen_share_policy, 'host_only');

  const denied = collect(p1, 'screen:denied');
  p1.emit('screen:request');
  await settle();
  assert.deepEqual(denied, [{ reason: 'host_only' }]);
});

test("switching to host_only leaves the host's own share running", async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  const host = await join('host');
  await join('p1');

  await shareScreen(host);
  host.emit('host:set-screen-policy', { policy: 'host_only' });
  await settle();

  assert.equal((await store.screenSharer(meetingId))?.userId, 'host');
  assert.equal(livekit.callsTo('revokeScreenShare').length, 0);
});

test('the host kicks someone: they are told, evicted, blocked in the database and refused on rejoin', async (t) => {
  const { db, meetingId, livekit, connect, join, store } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  const presence = collect(host, 'room:presence');
  const removed = waitForEvent(p1, 'meeting:removed');
  host.emit('host:kick', { userId: 'p1' });
  await removed;
  await settle();

  assert.deepEqual(
    presence.at(-1).people.map((p) => p.userId),
    ['host'],
  );
  assert.equal(await store.hasSeat(meetingId, 'p1'), false);
  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);

  const { rows } = await db.query(
    'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, 'p1'],
  );
  assert.notEqual(rows[0].removed_at, null);

  const p1b = connect('p1');
  const denied = waitForEvent(p1b, 'meeting:denied');
  p1b.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'removed' });
});

test('kicking someone in a full room hands their seat to the next in the lobby', async (t) => {
  const { meetingId, connect, join, store } = await roomHarness(t, { maxParticipants: 2 });
  const host = await join('host');
  await join('p1');
  const p2 = connect('p2');
  const waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await waiting;

  const admitted = waitForEvent(p2, 'meeting:admitted');
  host.emit('host:kick', { userId: 'p1' });
  await admitted;

  assert.equal(await store.hasSeat(meetingId, 'p2'), true);
  assert.equal(await store.hasSeat(meetingId, 'p1'), false);
});

test('kicking the presenter ends their share', async (t) => {
  const { meetingId, livekit, join, store } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  await shareScreen(p1);
  const states = collect(host, 'screen:state');
  host.emit('host:kick', { userId: 'p1' });
  await settle();

  assert.deepEqual(states.at(-1), { sharerUserId: null });
  assert.equal(await store.screenSharer(meetingId), null);
  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);
});

test('kicking someone who left a moment ago still keeps them out', async (t) => {
  const { meetingId, connect, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');

  p1.emit('meeting:leave');
  await settle();
  host.emit('host:kick', { userId: 'p1' });
  await settle();

  const p1b = connect('p1');
  const denied = waitForEvent(p1b, 'meeting:denied');
  p1b.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'removed' });
});

test('a join that lands mid-kick is refused, and the kick still works', async (t) => {
  const raw = await setupTestDb();
  const livekit = recordingLivekit();
  const { db, arm, paused, release } = gateQuery(raw, 'SELECT name, image_url FROM users WHERE id = $1', 'p1');
  const { meetingId, server, store } = await startRoom(db, { livekit });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await settle();
    await server.close();
    await raw.close();
  });

  const host = await seat(server.url, 'host', meetingId);
  clients.push(host);
  // p1 joins and leaves once first, so they hold a meeting_participants row
  // (removed_at IS NULL) before the gate goes live — otherwise host:kick's UPDATE
  // would match nothing and the race below wouldn't be the one the fix guards.
  const firstJoin = await seat(server.url, 'p1', meetingId);
  clients.push(firstJoin);
  firstJoin.emit('meeting:leave');
  await settle();

  arm();
  const rejoin = connectClient(server.url, 'p1');
  clients.push(rejoin);
  const denied = collect(rejoin, 'meeting:denied');
  const admitted = collect(rejoin, 'meeting:admitted');
  rejoin.emit('meeting:join-request', { meetingId });
  await paused; // rejoin is stuck awaiting userInfo, past its own isRemoved check

  host.emit('host:kick', { userId: 'p1' });
  await settle(); // host:kick's removed mark in the store and its DB commit both land while paused

  release();
  await settle();

  assert.deepEqual(denied, [{ reason: 'removed' }]);
  assert.deepEqual(admitted, []);
  assert.equal(await store.hasSeat(meetingId, 'p1'), false);

  const { rows } = await raw.query(
    'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, 'p1'],
  );
  assert.notEqual(rows[0].removed_at, null); // the kick's own DB write landed
});

test('a join that lands mid-end-for-all is refused', async (t) => {
  const raw = await setupTestDb();
  const livekit = recordingLivekit();
  const { db, arm, paused, release } = gateQuery(raw, 'SELECT name, image_url FROM users WHERE id = $1', 'p1');
  const { meetingId, server, store } = await startRoom(db, { livekit });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await settle();
    await server.close();
    await raw.close();
  });

  const host = await seat(server.url, 'host', meetingId);
  clients.push(host);

  arm();
  const p1 = connectClient(server.url, 'p1');
  clients.push(p1);
  const denied = collect(p1, 'meeting:denied');
  const admitted = collect(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await paused; // p1 is stuck awaiting userInfo, past its own isRemoved check

  host.emit('host:end-meeting');
  await settle(); // markEnded commits, sockets are told, the room is cleared in the store

  release();
  await settle();

  assert.deepEqual(denied, [{ reason: 'ended' }]);
  assert.deepEqual(admitted, []);
  assert.equal(await store.hasSeat(meetingId, 'p1'), false);
});

test('without LiveKit configured the host can still kick', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await startRoom(db); // livekit defaults to null
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await settle();
    await server.close();
    await db.close();
  });

  const host = await seat(server.url, 'host', meetingId);
  clients.push(host);
  const p1 = await seat(server.url, 'p1', meetingId);
  clients.push(p1);

  const removed = waitForEvent(p1, 'meeting:removed');
  host.emit('host:kick', { userId: 'p1' });
  await removed;
  await settle();

  assert.equal(await store.hasSeat(meetingId, 'p1'), false);
  const { rows } = await db.query(
    'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, 'p1'],
  );
  assert.notEqual(rows[0].removed_at, null);
});

test('the host cannot kick themselves', async (t) => {
  const { db, meetingId, livekit, join, store } = await roomHarness(t);
  const host = await join('host');

  host.emit('host:kick', { userId: 'host' });
  await settle();

  assert.equal(await store.hasSeat(meetingId, 'host'), true);
  const { rows } = await db.query(
    'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, 'host'],
  );
  assert.equal(rows[0].removed_at, null);
  assert.equal(livekit.callsTo('evict').length, 0);
});

test("host:mute mutes a seated participant's microphone, and nobody else's", async (t) => {
  const { meetingId, livekit, connect, join } = await roomHarness(t, { maxParticipants: 2 });
  const host = await join('host');
  await join('p1');
  const p2 = connect('p2');
  const waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await waiting;

  host.emit('host:mute', { userId: 'p1' });
  host.emit('host:mute', { userId: 'p2' });
  host.emit('host:mute', { userId: 'nobody' });
  await settle();

  assert.deepEqual(livekit.callsTo('muteMic'), [[meetingId, 'p1']]);
});

test('ending the meeting for everyone tells everyone, ends it, and closes the LiveKit room', async (t) => {
  const { db, meetingId, livekit, connect, join, store } = await roomHarness(t, { maxParticipants: 2 });
  const host = await join('host');
  const p1 = await join('p1');
  const p2 = connect('p2');
  const waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await waiting;

  const hostEnded = waitForEvent(host, 'meeting:ended');
  const p1Ended = waitForEvent(p1, 'meeting:ended');
  const p2Ended = waitForEvent(p2, 'meeting:ended');
  host.emit('host:end-meeting');
  await Promise.all([hostEnded, p1Ended, p2Ended]);
  await settle();

  assert.deepEqual(livekit.callsTo('endRoom'), [[meetingId]]);
  assert.deepEqual(await store.listSeats(meetingId), []);

  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].ended_at, null);

  const p1b = connect('p1');
  const denied = waitForEvent(p1b, 'meeting:denied');
  p1b.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'ended' });
});
