const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoomStore } = require('../lib/roomStore');
const { setupTestRedis, settle } = require('./helpers');

const CODE = 'abc-defg-hij';
// u9 is the host; max 3 means the host plus 2 others.
const META = { hostId: 'u9', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 3, mode: 'standard' };
const person = (n, socketId = `s${n}`) => ({ userId: `u${n}`, socketId, name: `User ${n}`, imageUrl: null });

async function room(t, meta = {}) {
  const store = createRoomStore(await setupTestRedis(t), { serverId: 'server-a' });
  await store.initMeta(CODE, { ...META, ...meta });
  return store;
}
const seat = (store, n, isHost = false) => store.join(CODE, person(n), { isHost });

test('the host seat is reserved on top of the max - 1 participant seats', async (t) => {
  const store = await room(t);
  assert.equal((await seat(store, 1)).result, 'seated');
  assert.equal((await seat(store, 2)).result, 'seated');
  assert.deepEqual(await seat(store, 3), { result: 'queued', replacedSocketId: null, position: 1 });
  assert.equal((await seat(store, 9, true)).result, 'seated');
  assert.equal((await store.listSeats(CODE)).length, 3);
});

test('50 joins at the same moment from two servers: exactly one gets the last seat', async (t) => {
  const a = createRoomStore(await setupTestRedis(t), { serverId: 'server-a' });
  const b = createRoomStore(await setupTestRedis(t), { serverId: 'server-b' });
  await a.initMeta(CODE, META);
  await seat(a, 9, true);
  await seat(a, 1);
  const outcomes = await Promise.all(
    Array.from({ length: 50 }, (_, i) => (i % 2 ? b : a).join(CODE, person(100 + i), { isHost: false })),
  );
  assert.equal(outcomes.filter((o) => o.result === 'seated').length, 1);
  const positions = outcomes.filter((o) => o.result === 'queued').map((o) => o.position).sort((x, y) => x - y);
  assert.deepEqual(positions, Array.from({ length: 49 }, (_, i) => i + 1));
});

test('the lobby is FIFO, a retry keeps its place, and a freed seat admits the first in line', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  assert.equal((await seat(store, 3)).position, 1);
  assert.equal((await seat(store, 4)).position, 2);
  assert.equal((await seat(store, 5)).position, 3);
  const retry = await store.join(CODE, person(4, 's4b'), { isHost: false });
  assert.equal(retry.position, 2);
  assert.equal(await store.queueSocketId(CODE, 'u4'), 's4b');

  assert.deepEqual(await store.drainQueue(CODE), []); // still full
  assert.equal(await store.releaseSeat(CODE, 'u2'), true);
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u3']);
  assert.equal(await store.queuePosition(CODE, 'u4'), 1);
  assert.equal(await store.queuePosition(CODE, 'u5'), 2);
  assert.equal(await store.queuePosition(CODE, 'u3'), null);
});

test('manual admission: everyone but the host waits; switching to auto drains in order until full', async (t) => {
  const store = await room(t, { admission: 'manual', maxParticipants: 3 });
  assert.equal((await seat(store, 9, true)).result, 'seated');
  for (const n of [2, 3, 4]) assert.equal((await seat(store, n)).result, 'queued');
  assert.equal(await store.setMetaField(CODE, 'admission', 'auto'), true);
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u2', 'u3']);
  assert.deepEqual((await store.queuedEntries(CODE)).map((e) => e.userId), ['u4']);
  assert.equal(await store.queuePosition(CODE, 'u4'), 1);
});

test('admitFromQueue: gone, full, or seated and out of the lobby in one step', async (t) => {
  const store = await room(t, { admission: 'manual', maxParticipants: 2 });
  await seat(store, 9, true);
  await seat(store, 1);
  await seat(store, 2);
  assert.deepEqual(await store.admitFromQueue(CODE, 'u7'), { result: 'gone', entry: null });
  assert.equal((await store.admitFromQueue(CODE, 'u1')).result, 'admitted');
  assert.equal((await store.admitFromQueue(CODE, 'u2')).result, 'full');
  assert.equal(await store.queuePosition(CODE, 'u2'), 1, 'a full room keeps them in line');
  assert.equal(await store.hasSeat(CODE, 'u1'), true);
  assert.equal(await store.queueSocketId(CODE, 'u1'), null);
});

test('removed, ended and a full translator convo are refused, not queued', async (t) => {
  const store = await room(t);
  await store.addRemoved(CODE, 'u1');
  assert.equal((await seat(store, 1)).result, 'removed');
  assert.equal((await store.join('zzz-zzzz-zzz', person(1), { isHost: false })).result, 'ended'); // never initialised

  const convoCode = 'cnv-cnvo-cnv';
  await store.initMeta(convoCode, { ...META, mode: 'translator', maxParticipants: 2 });
  await store.join(convoCode, person(9), { isHost: true });
  await store.join(convoCode, person(2), { isHost: false });
  assert.equal((await store.join(convoCode, person(3), { isHost: false })).result, 'full');
});

test('an ended meeting cannot be brought back for an hour; a cleared, never-started one can', async (t) => {
  const store = await room(t);
  await store.clearMeeting(CODE, { ended: true });
  assert.equal(await store.initMeta(CODE, META), false);
  assert.equal((await seat(store, 1)).result, 'ended');

  const other = 'xyz-wxyz-xyz';
  await store.initMeta(other, META);
  await store.clearMeeting(other, { ended: false });
  assert.equal(await store.initMeta(other, META), true);
});

test('a second tab takes the seat over, reports the old socket, and keeps its place in the roster', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  const second = await store.join(CODE, person(1, 's1b'), { isHost: false });
  assert.deepEqual(second, { result: 'seated', replacedSocketId: 's1', position: null });
  assert.deepEqual((await store.listSeats(CODE)).map((s) => s.userId), ['u1', 'u2']);
  assert.equal(await store.seatSocketId(CODE, 'u1'), 's1b');
});

test('seatFor returns the seat record, or null for a stranger or an unknown meeting', async (t) => {
  const store = await room(t);
  await seat(store, 9, true);
  const s = await store.seatFor(CODE, 'u9');
  assert.equal(s.userId, 'u9');
  assert.equal(s.socketId, 's9');
  assert.equal(s.serverId, 'server-a');
  assert.equal(s.name, 'User 9');
  assert.equal(s.imageUrl, null);
  assert.equal(s.isHost, true);
  assert.equal(s.lang, null);
  assert.equal(await store.seatFor(CODE, 'u2'), null);
  assert.equal(await store.seatFor('zzz-zzzz-zzz', 'u9'), null);
});

test('grace: the seat is held until the deadline, then released once', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  assert.equal(await store.markGrace(CODE, 'u1', 's1', 50), true);
  assert.equal(await store.hasSeat(CODE, 'u1'), true);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), false, 'not yet');
  await settle(80);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), true);
  assert.equal(await store.hasSeat(CODE, 'u1'), false);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), false, 'only once');
});

test('grace: coming back on any server ends it, and keepSeat clears a stamp', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await store.markGrace(CODE, 'u1', 's1', 50);
  await store.join(CODE, person(1, 's1b'), { isHost: false });
  await settle(80);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), false);
  assert.equal((await store.seatFor(CODE, 'u1')).graceUntil, undefined);

  await store.markGrace(CODE, 'u1', 's1b', 50);
  assert.equal(await store.keepSeat(CODE, 'u1', 's1b'), true);
  await settle(80);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1b'), false);
});

test('only the socket that holds a seat or lobby entry can give it up, unless no socket is named', async (t) => {
  const store = await room(t, { maxParticipants: 2 });
  await seat(store, 1);
  await seat(store, 2); // queued
  assert.equal(await store.releaseSeat(CODE, 'u1', 'someone-else'), false);
  assert.equal(await store.removeFromQueue(CODE, 'u2', 'someone-else'), false);
  assert.equal(await store.markGrace(CODE, 'u1', 'someone-else', 50), false);
  assert.equal(await store.setSeatLang(CODE, 'u1', 'someone-else', 'hi'), false);
  assert.equal(await store.releaseSeat(CODE, 'u1', 's1'), true);
  assert.equal(await store.removeFromQueue(CODE, 'u2'), true); // the host acting: any socket
});

test('screen lock: one sharer, owned by a socket, and only for someone seated', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  const [a, b] = await Promise.all([
    store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' }),
    store.takeScreenLock(CODE, { userId: 'u2', socketId: 's2' }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  const winner = a.ok ? 'u1' : 'u2';
  assert.equal((a.ok ? b : a).sharerUserId, winner);
  assert.deepEqual(await store.takeScreenLock(CODE, { userId: 'u7', socketId: 's7' }), { ok: false, reason: 'noseat' });

  await store.releaseScreenLock(CODE, winner === 'u1' ? 's1' : 's2');
  assert.equal((await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' })).ok, true);
  assert.equal((await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' })).ok, true, 'the same page may ask again');
  assert.equal(await store.releaseScreenLock(CODE, 's2'), null, 'only the holder releases');
  assert.deepEqual(await store.releaseScreenLock(CODE, 's1'), { userId: 'u1', socketId: 's1' });
  assert.equal(await store.screenSharer(CODE), null);
});

test('screen lock: host-only is enforced inside the script', async (t) => {
  const store = await room(t, { screenSharePolicy: 'host_only' });
  await seat(store, 9, true);
  await seat(store, 1);
  assert.deepEqual(await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' }), { ok: false, reason: 'host_only' });
  assert.equal((await store.takeScreenLock(CODE, { userId: 'u9', socketId: 's9' })).ok, true);
});

test('the sharer losing their seat loses the lock, by leaving or by grace running out', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' });
  await store.releaseSeat(CODE, 'u2'); // someone else leaving changes nothing
  assert.equal((await store.screenSharer(CODE)).userId, 'u1');
  await store.releaseSeat(CODE, 'u1');
  assert.equal(await store.screenSharer(CODE), null);

  await store.join(CODE, person(1), { isHost: false });
  await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' });
  await store.markGrace(CODE, 'u1', 's1', 20);
  await settle(50);
  await store.releaseIfStale(CODE, 'u1', 's1');
  assert.equal(await store.screenSharer(CODE), null);
});

test('clearMeeting returns every socket it dropped and leaves nothing behind', async (t) => {
  const store = await room(t, { maxParticipants: 2 });
  await seat(store, 9, true);
  await seat(store, 1);
  await seat(store, 2); // queued
  const ids = await store.clearMeeting(CODE);
  assert.deepEqual(ids.sort(), ['s1', 's2', 's9']);
  assert.equal(await store.getMeta(CODE), null);
  assert.deepEqual(await store.listSeats(CODE), []);
  assert.deepEqual(await store.queuedEntries(CODE), []);
  assert.deepEqual(await store.liveMeetings(), []);
});

test('clearIfIdle: only an empty room that has existed long enough', async (t) => {
  const store = await room(t);
  assert.equal(await store.clearIfIdle(CODE, 60_000), false, 'too new');
  await seat(store, 1);
  assert.equal(await store.clearIfIdle(CODE, 0), false, 'someone is seated');
  await store.releaseSeat(CODE, 'u1');
  assert.equal(await store.clearIfIdle(CODE, 0), true);
  assert.equal(await store.getMeta(CODE), null);
});

test('setSeatLang and setMetaField change only what exists', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  assert.equal(await store.setSeatLang(CODE, 'u1', 's1', 'hi'), true);
  assert.equal((await store.seatFor(CODE, 'u1')).lang, 'hi');
  await store.clearMeeting(CODE);
  assert.equal(await store.setMetaField(CODE, 'admission', 'manual'), false, 'no room to change');
  assert.equal(await store.getMeta(CODE), null);
});

test('heartbeats: a server is alive while it beats', async (t) => {
  const redis = await setupTestRedis(t);
  const store = createRoomStore(redis, { serverId: 'server-a' });
  assert.equal(await store.isServerAlive('server-a'), false);
  await store.beat();
  assert.equal(await store.isServerAlive('server-a'), true);
  assert.ok((await redis.pttl('zylo:server:server-a')) <= 30_000);
});

test('drainQueue seats nobody while admission is manual, even if the caller read "auto" a moment ago', async (t) => {
  const store = await room(t, { maxParticipants: 2 });
  await seat(store, 1);
  await seat(store, 2); // queued: the room is full
  await store.setMetaField(CODE, 'admission', 'manual'); // the host, on another server
  await store.releaseSeat(CODE, 'u1');
  assert.deepEqual(await store.drainQueue(CODE), [], 'manual: the host decides who comes in');
  assert.deepEqual((await store.queuedEntries(CODE)).map((e) => e.userId), ['u2']);
  assert.equal(await store.hasSeat(CODE, 'u2'), false);

  await store.setMetaField(CODE, 'admission', 'auto');
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u2']);
});

test('a newcomer cannot take a freed seat ahead of someone already in the lobby', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  assert.equal((await seat(store, 3)).position, 1);
  await store.releaseSeat(CODE, 'u2'); // a seat is free, but u3 was here first
  assert.deepEqual(await store.join(CODE, person(10), { isHost: false }), {
    result: 'queued',
    replacedSocketId: null,
    position: 2,
  });
  assert.equal(await store.hasSeat(CODE, 'u10'), false);
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u3']);
  assert.equal(await store.queuePosition(CODE, 'u10'), 1);
});

test('initMeta on a room that already exists renews its age, so the sweeper cannot take it mid-join', async (t) => {
  const store = await room(t);
  await settle(80);
  assert.equal(await store.initMeta(CODE, META), true); // a join into the older, empty room
  assert.equal(await store.clearIfIdle(CODE, 50), false, 'it is new again');
  assert.notEqual(await store.getMeta(CODE), null);
});

// host:kick reads the seat and then the lobby entry; a drain on another server can move
// the user from one to the other in between. Both scripts therefore check the removed set.
test('drainQueue skips a removed user and leaves them queued, so the kick can still find them', async (t) => {
  const store = await room(t, { maxParticipants: 2 });
  await seat(store, 1);
  await seat(store, 2); // queued: the room is full
  await seat(store, 3);
  await store.addRemoved(CODE, 'u2');
  await store.releaseSeat(CODE, 'u1');
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u3'], 'the seat goes past the removed user');
  assert.equal(await store.hasSeat(CODE, 'u2'), false);
  assert.equal(await store.queueSocketId(CODE, 'u2'), 's2', 'still queued: removeFromQueue finds them');
});

test('admitFromQueue refuses a removed user: gone, not seated, still queued', async (t) => {
  const store = await room(t, { admission: 'manual' });
  await seat(store, 1);
  await store.addRemoved(CODE, 'u1');
  assert.deepEqual(await store.admitFromQueue(CODE, 'u1'), { result: 'gone', entry: null });
  assert.equal(await store.hasSeat(CODE, 'u1'), false);
  assert.equal(await store.queuePosition(CODE, 'u1'), 1);
});

test('aiEnabled: on unless told otherwise, read as a boolean, changed with setMetaField', async (t) => {
  const redis = await setupTestRedis(t);
  const store = createRoomStore(redis, { serverId: 'server-a' });
  await store.initMeta(CODE, META); // META says nothing about AI
  assert.equal((await store.getMeta(CODE)).aiEnabled, true);
  await store.setMetaField(CODE, 'aiEnabled', '0');
  assert.equal((await store.getMeta(CODE)).aiEnabled, false);
  // A room set up by a server from before AI existed has no such field: on.
  await redis.hdel(`zylo:room:{${CODE}}:meta`, 'aiEnabled');
  assert.equal((await store.getMeta(CODE)).aiEnabled, true);
  await store.initMeta('off-offo-off', { ...META, aiEnabled: false });
  assert.equal((await store.getMeta('off-offo-off')).aiEnabled, false);
});

test('nudges: off and every signal empty unless told otherwise; saved on, the quiet clock starts', async (t) => {
  const store = await room(t); // META says nothing about nudges
  const meta = await store.getMeta(CODE);
  assert.deepEqual(
    [meta.aiNudges, meta.nudgesOnAt, meta.lastVoiceAt, meta.lastChatAt, meta.quietNudged],
    [false, 0, 0, 0, false],
  );
  const before = Date.now();
  await store.initMeta('nud-geso-nnn', { ...META, aiNudges: true });
  const on = await store.getMeta('nud-geso-nnn');
  assert.equal(on.aiNudges, true);
  assert.ok(on.nudgesOnAt >= before && on.nudgesOnAt <= Date.now(), `nudgesOnAt ${on.nudgesOnAt}`);
});

test('touch stamps a signal and ends the quiet stretch, and never recreates a cleared room', async (t) => {
  const redis = await setupTestRedis(t);
  const store = createRoomStore(redis, { serverId: 'server-a' });
  await store.initMeta(CODE, META);
  await store.setMetaField(CODE, 'quietNudged', '1');
  assert.equal((await store.getMeta(CODE)).quietNudged, true);
  const before = Date.now();
  assert.equal(await store.touch(CODE, 'lastVoiceAt'), true);
  const meta = await store.getMeta(CODE);
  assert.ok(meta.lastVoiceAt >= before && meta.lastVoiceAt <= Date.now(), `lastVoiceAt ${meta.lastVoiceAt}`);
  assert.equal(meta.quietNudged, false);
  await store.clearMeeting(CODE, { ended: true });
  assert.equal(await store.touch(CODE, 'lastChatAt'), false);
  assert.equal(await redis.exists(`zylo:room:{${CODE}}:meta`), 0);
});

test('claimNudge: one claim per meeting across servers, held for 90 s', async (t) => {
  const redis = await setupTestRedis(t);
  const a = createRoomStore(redis, { serverId: 'server-a' });
  const b = createRoomStore(await setupTestRedis(t), { serverId: 'server-b' });
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? b : a).claimNudge(CODE)));
  assert.equal(claims.filter(Boolean).length, 1);
  const ttl = await redis.pttl(`zylo:room:{${CODE}}:nudge`);
  assert.ok(ttl > 85_000 && ttl <= 90_000, `pttl ${ttl}`);
  assert.equal(await a.claimNudge('xyz-wxyz-xyz'), true, 'another meeting has its own claim');
});

test('initMeta on a room that exists only renews its age: the nudges setting and the quiet clock stay put', async (t) => {
  const on = await room(t, { aiNudges: true });
  await on.setMetaField(CODE, 'nudgesOnAt', 1000);
  await on.initMeta(CODE, { ...META, aiNudges: false }); // a join into the running room, whatever the row says
  let meta = await on.getMeta(CODE);
  assert.deepEqual([meta.aiNudges, meta.nudgesOnAt], [true, 1000]);

  const off = await room(t, { aiNudges: false });
  await off.initMeta(CODE, { ...META, aiNudges: true });
  meta = await off.getMeta(CODE);
  assert.deepEqual([meta.aiNudges, meta.nudgesOnAt], [false, 0]);
});
