const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoomStore } = require('../lib/roomStore');
const { createAi } = require('../lib/ai');
const { twoServerHarness, insertMeeting, waitForEvent, collect, settle, startFakeAi, aiAnswer } = require('./helpers');

// Whether `promise` settles within ms: a missing event fails an assertion, not the run.
const within = (promise, ms) => Promise.race([promise.then(() => true), settle(ms).then(() => false)]);

// Seats held on a server that died: no heartbeat for it exists.
const deadServerStore = (redis) => createRoomStore(redis, { serverId: 'crashed-server' });
const deadServerUser = (userId, name) => ({ userId, socketId: `socket-of-${userId}`, name, imageUrl: null, lang: null });

test('chat sent on one server reaches people on the other', async (t) => {
  const { a, b } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const got = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: 'hello from server A' });
  assert.equal((await got).text, 'hello from server A');
});

test('a question asked on one server streams to people on the other', async (t) => {
  const provider = await startFakeAi(t, aiAnswer(['From ', 'server A.'], { gapMs: 120 }));
  const ai = createAi({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' });
  const { a, b } = await twoServerHarness(t, { ai });
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const question = waitForEvent(p1, 'chat:message');
  const start = waitForEvent(p1, 'ai:start');
  const chunks = collect(p1, 'ai:chunk');
  const done = waitForEvent(p1, 'ai:done');
  host.emit('ai:ask', { text: 'Which server answers?' });
  assert.equal((await question).toAi, true);
  const { id } = await start;
  assert.equal((await done).text, 'From server A.');
  assert.equal(chunks.map((c) => c.delta).join(''), 'From server A.');
  assert.ok(chunks.every((c) => c.id === id));
  assert.equal(provider.requests.length, 1, "only the asker's server calls the provider");
});

test('two servers sweeping one quiet meeting post one nudge, and the provider is asked once', async (t) => {
  const provider = await startFakeAi(t, aiAnswer(['Shall we pick a date?']));
  const ai = createAi({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' });
  const { db, meetingId, a, b } = await twoServerHarness(t, { ai });
  await db.query('UPDATE meetings SET ai_nudges = true WHERE id = $1', [meetingId]);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  for (const [client, text] of [[host, 'Agenda: the launch date'], [p1, 'Friday or Monday']]) {
    const back = waitForEvent(client, 'chat:message');
    client.emit('chat:message', { text });
    await back;
  }
  await settle();
  const longAgo = Date.now() - 61_000;
  for (const field of ['nudgesOnAt', 'lastVoiceAt', 'lastChatAt']) await a.store.setMetaField(meetingId, field, longAgo);
  const heard = [collect(host, 'ai:nudge'), collect(p1, 'ai:nudge')];
  const first = waitForEvent(p1, 'ai:nudge');
  await Promise.all([a.handlers.sweep(), b.handlers.sweep()]);
  assert.equal((await first).reason, 'quiet');
  await settle(200);
  assert.deepEqual(heard.map((got) => got.length), [1, 1]);
  assert.equal(provider.requests.length, 1);
});

test('two joins on different servers race for the last seat: exactly one gets it', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t); // max 3: the host + 2
  await a.join('host');
  await b.join('p1');
  const c2 = a.connect('p2');
  const c3 = b.connect('p3');
  await Promise.all([waitForEvent(c2, 'connect'), waitForEvent(c3, 'connect')]);
  const outcome = (c) =>
    Promise.race([
      waitForEvent(c, 'meeting:admitted').then(() => 'admitted'),
      waitForEvent(c, 'meeting:waiting').then(() => 'waiting'),
    ]);
  const results = Promise.all([outcome(c2), outcome(c3)]);
  c2.emit('meeting:join-request', { meetingId });
  c3.emit('meeting:join-request', { meetingId });
  assert.deepEqual((await results).sort(), ['admitted', 'waiting']);
});

test('a host on one server removes someone on the other', async (t) => {
  const { a, b, meetingId, livekit } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const removed = waitForEvent(p1, 'meeting:removed');
  host.emit('host:kick', { userId: 'p1' });
  await removed;
  await settle(150);
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), false);
  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);
});

test('the host admits someone waiting on the other server, who then gets the roster', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t, { admission: 'manual' });
  const host = await a.join('host');
  const waiter = b.connect('p1');
  const waiting = waitForEvent(waiter, 'meeting:waiting');
  waiter.emit('meeting:join-request', { meetingId });
  await waiting;
  const admitted = waitForEvent(waiter, 'meeting:admitted');
  const presence = waitForEvent(waiter, 'room:presence');
  const ack = new Promise((resolve) => host.emit('lobby:admit', { userId: 'p1' }, resolve));
  assert.deepEqual(await ack, { ok: true });
  await admitted;
  assert.deepEqual((await presence).people.map((p) => p.userId).sort(), ['host', 'p1']);
});

test('a replaced host tab on the other server keeps no host powers', async (t) => {
  const { a, b, meetingId, livekit } = await twoServerHarness(t);
  const tabA = await a.join('host');
  await a.join('p1');
  const tabB = b.connect('host');
  const admitted = waitForEvent(tabB, 'meeting:admitted');
  tabB.emit('meeting:join-request', { meetingId });
  await admitted;
  const forbidden = collect(tabA, 'error:forbidden');
  tabA.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(forbidden.length, 1);
  assert.equal(livekit.callsTo('muteMic').length, 0);
});

test('dropping off one server and coming back on the other keeps the seat', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t);
  await a.join('host');
  const first = await a.join('p1');
  first.disconnect();
  await settle(20);
  await b.join('p1');
  await settle(150); // past the 60 ms grace server A started
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true);
});

test("a crashed server's seat is held for the grace period, then freed by the sweep", async (t) => {
  const { a, meetingId, redis } = await twoServerHarness(t);
  const host = await a.join('host');
  // A seat held on a server that died: no heartbeat for it exists.
  const ghost = createRoomStore(redis, { serverId: 'crashed-server' });
  await ghost.join(meetingId, { userId: 'p1', socketId: 'socket-on-a-dead-server', name: 'Priya One', imageUrl: null, lang: null }, { isHost: false });
  const presence = collect(host, 'room:presence');
  await a.handlers.sweep(); // stamps the grace period
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true, 'held while they might come back');
  await settle(100); // graceMs is 60 in tests
  await a.handlers.sweep(); // releases it
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), false);
  await settle(50);
  assert.deepEqual(presence.at(-1).people.map((p) => p.userId), ['host']);
});

test("a live server's seats are left alone by the other server's sweep", async (t) => {
  const { a, b, db, meetingId } = await twoServerHarness(t);
  await a.join('host');
  await b.join('p1');
  await a.handlers.sweep();
  await settle(100);
  await a.handlers.sweep();
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true);
  assert.equal((await a.store.seatFor(meetingId, 'p1')).graceUntil, undefined);
  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ended_at, null, 'a meeting held by a live server is not ended');
});

test('a meeting live in Postgres but held by no server is ended by the sweep', async (t) => {
  const { a, db, meetingId } = await twoServerHarness(t);
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [meetingId]);
  await a.handlers.sweep();
  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].ended_at, null);
});

test('a meeting live in Postgres but gone from Redis is ended for everyone in it', async (t) => {
  const { a, b, db, redis, livekit, meetingId } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  await a.store.clearMeeting(meetingId); // Redis loses the room; both tabs stay connected
  const told = Promise.all([waitForEvent(host, 'meeting:ended'), waitForEvent(p1, 'meeting:ended')]);
  await a.handlers.sweep();
  assert.equal(await within(told, 1000), true, 'both people, on both servers, are told');
  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].ended_at, null);
  assert.deepEqual(livekit.callsTo('endRoom'), [[meetingId]]);
  assert.equal(await redis.exists(`zylo:room:{${meetingId}}:ended`), 1, 'the tombstone refuses a rejoin');
});

test('a room missing from the live set but alive in Redis is put back, not ended', async (t) => {
  const { a, db, livekit, meetingId } = await twoServerHarness(t);
  const host = await a.join('host');
  await a.store.forgetLive(meetingId);
  const ended = collect(host, 'meeting:ended');
  await a.handlers.sweep();
  await settle(100);
  assert.deepEqual(await a.store.liveMeetings(), [meetingId]);
  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ended_at, null);
  assert.equal(ended.length, 0);
  assert.equal(livekit.callsTo('endRoom').length, 0);
});

test('a room that fails in the sweep does not stop the other rooms or the Postgres pass', async (t) => {
  const { a, db, redis, meetingId } = await twoServerHarness(t);
  const errors = t.mock.method(console, 'error', () => {});
  await a.join('host');
  // A second room with a seat on a dead server, and a third live in Postgres only.
  await insertMeeting(db, { id: 'sec-ondr-oom', hostId: 'host', maxParticipants: 3 });
  await insertMeeting(db, { id: 'thi-rdme-eti', hostId: 'host' });
  await db.query("UPDATE meetings SET started_at = now() WHERE id = 'thi-rdme-eti'");
  const ghost = deadServerStore(redis);
  await ghost.initMeta('sec-ondr-oom', { hostId: 'host', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 3, mode: 'standard' });
  await ghost.join('sec-ondr-oom', deadServerUser('p1', 'Priya One'), { isHost: false });
  // The sweep reaches the failing room first.
  a.store.liveMeetings = async () => [meetingId, 'sec-ondr-oom'];
  const listSeats = a.store.listSeats;
  a.store.listSeats = async (id) => {
    if (id === meetingId) throw new Error('redis hiccup');
    return listSeats(id);
  };
  await a.handlers.sweep();
  assert.notEqual((await a.store.seatFor('sec-ondr-oom', 'p1')).graceUntil, undefined, 'the next room was still swept');
  const { rows } = await db.query("SELECT ended_at FROM meetings WHERE id = 'thi-rdme-eti'");
  assert.notEqual(rows[0].ended_at, null, 'and so was the Postgres pass');
  assert.equal(errors.mock.calls.filter((c) => String(c.arguments[0]).startsWith('room sweep failed')).length, 1);
});

// The host and one member on server A and B, and a seat held by a dead server: the room is
// full, so a third person on B waits. Freeing the dead seat is what the sweep does next.
async function fullRoomWithAWaiter(t) {
  const h = await twoServerHarness(t); // max 3: the host + 2
  const { a, b, meetingId, redis } = h;
  t.mock.method(console, 'error', () => {}); // the failures these tests make on purpose
  await a.join('host');
  await b.join('p1');
  await deadServerStore(redis).join(meetingId, deadServerUser('p2', 'Pablo Two'), { isHost: false });
  const waiter = b.connect('p3');
  const waiting = waitForEvent(waiter, 'meeting:waiting');
  waiter.emit('meeting:join-request', { meetingId });
  await waiting;
  return { ...h, waiter };
}

// Two sweeps: the first stamps the dead seat's grace period, the second releases it and
// offers it to the lobby. beforeRelease runs in between.
async function sweepAwayTheDeadSeat(a, beforeRelease = () => {}) {
  await a.handlers.sweep();
  await settle(100); // graceMs is 60 in tests
  await beforeRelease();
  await a.handlers.sweep();
}

test('a waiter left behind by a failed drain is admitted by the next sweep', async (t) => {
  const { a, meetingId, waiter } = await fullRoomWithAWaiter(t);
  const drainQueue = a.store.drainQueue;
  await sweepAwayTheDeadSeat(a, () => {
    let failures = 1; // the first drain once a seat is free
    a.store.drainQueue = async (id) => {
      if (failures-- > 0) throw new Error('redis hiccup');
      return drainQueue(id);
    };
  });
  assert.equal(await a.store.queuePosition(meetingId, 'p3'), 1, 'the failed drain left them waiting');
  const admitted = waitForEvent(waiter, 'meeting:admitted');
  const presence = waitForEvent(waiter, 'room:presence');
  await a.handlers.sweep();
  assert.equal(await within(admitted, 1000), true, 'admitted');
  assert.deepEqual((await presence).people.map((p) => p.userId).sort(), ['host', 'p1', 'p3']);
  assert.equal(await a.store.queuePosition(meetingId, 'p3'), null);
});

test('a waiter is admitted even when the adapter cannot say whether they are connected', async (t) => {
  const { a, meetingId, waiter } = await fullRoomWithAWaiter(t);
  const realIn = a.io.in.bind(a.io);
  a.io.in = (room) => {
    const op = realIn(room);
    op.fetchSockets = () => Promise.reject(new Error('timeout reached while waiting for fetchSockets response'));
    return op;
  };
  const admitted = waitForEvent(waiter, 'meeting:admitted');
  await sweepAwayTheDeadSeat(a);
  assert.equal(await within(admitted, 1000), true);
  assert.equal(await a.store.hasSeat(meetingId, 'p3'), true);
});

test('admitting a waiter asks the adapter only when they are on another live server', async (t) => {
  const { a, b, redis, meetingId } = await twoServerHarness(t, { admission: 'manual', maxParticipants: 5 });
  const host = await a.join('host');
  const local = a.connect('p1');
  const remote = b.connect('p2');
  for (const [client, userId] of [[local, 'p1'], [remote, 'p2']]) {
    const waiting = waitForEvent(client, 'meeting:waiting');
    client.emit('meeting:join-request', { meetingId });
    await waiting;
  }
  await deadServerStore(redis).join(meetingId, deadServerUser('p3', 'Pia Three'), { isHost: false }); // waits too
  const asked = [];
  const realIn = a.io.in.bind(a.io);
  a.io.in = (room) => {
    const op = realIn(room);
    const fetchSockets = op.fetchSockets.bind(op);
    op.fetchSockets = () => {
      asked.push(room);
      return fetchSockets();
    };
    return op;
  };
  const admit = (userId) => new Promise((resolve) => host.emit('lobby:admit', { userId }, resolve));
  assert.deepEqual(await admit('p1'), { ok: true });
  assert.deepEqual(asked, [], 'a socket of ours is in this process');
  assert.deepEqual(await admit('p3'), { ok: false, reason: 'gone' });
  assert.deepEqual(asked, [], 'a server that stopped its heartbeat has no sockets');
  assert.deepEqual(await admit('p2'), { ok: true });
  assert.deepEqual(asked, [remote.id], 'only a live other server is asked');
});

test('connections are WebSocket only: a long-polling handshake is refused, a WebSocket client connects', async (t) => {
  const { a } = await twoServerHarness(t);
  const res = await fetch(`${a.url}/socket.io/?EIO=4&transport=polling`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { code: 0, message: 'Transport unknown' });
  const client = a.connect('host');
  await waitForEvent(client, 'connect');
});
