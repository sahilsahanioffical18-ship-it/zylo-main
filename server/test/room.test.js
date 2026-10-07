const test = require('node:test');
const assert = require('node:assert/strict');
const { registerRoomHandlers } = require('../lib/room');
const { createRoomStore } = require('../lib/roomStore');
const { createChatHistory } = require('../lib/chatHistory');
const {
  setupTestDb,
  connectTestRedis,
  seedMeeting,
  fakeSocketAuth,
  startSocketServer,
  startRoom,
  roomHarness,
  takeOverSeat,
  connectClient,
  waitForEvent,
  collect,
  settle,
  insertMeeting,
} = require('./helpers');

// setupTestDb truncates every table and node:test runs these sequentially, so one
// id is enough. Each startRoom brings a freshly emptied Redis to match.
const MEETING_ID = 'abc-defg-hij';

// maxParticipants = 3 everywhere, matching the spec's acceptance list:
// the host plus 2 others.
async function scenario(db, { admission = 'auto', maxParticipants = 3 } = {}) {
  return startRoom(db, { admission, maxParticipants });
}

test('auto mode: two people race for the last seat, exactly one is admitted', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  // Host takes the reserved seat, p1 takes the one participant seat.
  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }

  // p2 and p3 request together; max is 3, so only one more fits.
  const c2 = connectClient(server.url, 'p2');
  const c3 = connectClient(server.url, 'p3');
  clients.push(c2, c3);
  await Promise.all([waitForEvent(c2, 'connect'), waitForEvent(c3, 'connect')]);

  const settled = (c) =>
    Promise.race([
      waitForEvent(c, 'meeting:admitted').then(() => ({ admitted: true })),
      waitForEvent(c, 'meeting:waiting').then((payload) => ({ admitted: false, payload })),
    ]);
  const results = Promise.all([settled(c2), settled(c3)]);
  c2.emit('meeting:join-request', { meetingId });
  c3.emit('meeting:join-request', { meetingId });
  const [r2, r3] = await results;

  assert.equal([r2.admitted, r3.admitted].filter(Boolean).length, 1);
  const waiting = r2.admitted ? r3 : r2;
  assert.deepEqual(waiting.payload, { position: 1, manual: false });
});

test('auto mode: an explicit leave admits the waiting user', async (t) => {
  const db = await setupTestDb();
  // maxParticipants: 2 here (not the default 3) — host + p1 must fill the
  // room's one non-host slot completely, so p2's solo request actually queues
  // instead of finding a second slot still free.
  const { meetingId, server } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, hostP1] = clients;

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  const waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await waiting, { position: 1, manual: false });

  const admitted = waitForEvent(c2, 'meeting:admitted');
  const presence = waitForEvent(c2, 'room:presence');
  hostP1.emit('meeting:leave');
  await admitted;
  const { people } = await presence;
  assert.deepEqual(people.map((p) => p.userId).sort(), ['host', 'p2']);
  assert.equal(people.find((p) => p.userId === 'host').isHost, true);
  assert.equal(people.find((p) => p.userId === 'p2').name, 'Pablo Two');
});

test('a dropped connection keeps the seat for the grace period, then frees it', async (t) => {
  const db = await setupTestDb();
  // Same reasoning as the previous test: max 2 so host + p1 fill the one
  // non-host slot, making p2's solo request queue instead of being admitted.
  const { meetingId, server, store } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, p1] = clients;

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  const waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  await waiting;

  p1.disconnect();
  // graceMs is 60 in these tests; the seat must still be held well inside it.
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(await store.hasSeat(meetingId, 'p1'), true);

  await waitForEvent(c2, 'meeting:admitted');
  assert.equal(await store.hasSeat(meetingId, 'p1'), false);
});

// The grace timer must not start until Redis has stamped the deadline: a timer that
// fires first finds nothing overdue, and the seat would never be freed.
test('a dropped seat is still freed when stamping its grace deadline is slower than the grace period', async (t) => {
  const db = await setupTestDb();
  const redis = await connectTestRedis();
  const meetingId = await seedMeeting(db, { maxParticipants: 2 });
  const real = createRoomStore(redis, { serverId: 'slow' });
  const store = { ...real, markGrace: async (...args) => { await settle(150); return real.markGrace(...args); } };
  let handlers;
  const server = await startSocketServer((io) => {
    io.use(fakeSocketAuth);
    handlers = registerRoomHandlers(io, { db, graceMs: 60, store, history: createChatHistory(redis) });
  });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await settle(300); // in-flight disconnect handling
    handlers.stop();
    await server.close();
    await redis.quit();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, p1] = clients;
  const p2 = connectClient(server.url, 'p2');
  clients.push(p2);
  const waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await waiting;

  const admitted = [];
  p2.on('meeting:admitted', () => admitted.push(true));
  p1.disconnect();
  await settle(600);

  assert.equal(admitted.length, 1);
  assert.equal(await real.hasSeat(meetingId, 'p1'), false);
});

test('a second tab takes the seat over and the first tab is told', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const first = connectClient(server.url, 'p1');
  clients.push(first);
  const firstAdmitted = waitForEvent(first, 'meeting:admitted');
  first.emit('meeting:join-request', { meetingId });
  await firstAdmitted;

  const second = connectClient(server.url, 'p1');
  clients.push(second);
  const replaced = waitForEvent(first, 'meeting:replaced');
  const secondAdmitted = waitForEvent(second, 'meeting:admitted');
  second.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, secondAdmitted]);

  assert.equal((await store.listSeats(meetingId)).length, 1);

  // The replaced tab must not be able to release the new tab's seat.
  first.disconnect();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await store.hasSeat(meetingId, 'p1'), true);
});

test('a request for an unknown meeting is denied', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const c = connectClient(server.url, 'p1');
  clients.push(c);
  const denied = waitForEvent(c, 'meeting:denied');
  c.emit('meeting:join-request', { meetingId: 'zzz-zzzz-zzz' });
  assert.deepEqual(await denied, { reason: 'not_found' });
});

test('a removed user cannot rejoin', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  await db.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, role, removed_at)
     VALUES ($1, 'p1', 'participant', now())`,
    [meetingId],
  );
  const c = connectClient(server.url, 'p1');
  clients.push(c);
  const denied = waitForEvent(c, 'meeting:denied');
  c.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'removed' });
});

test('a stale tab dropping out of the queue does not evict a newer tab for the same user', async (t) => {
  const db = await setupTestDb();
  // max 2 so host + p1 fill the room's one non-host slot, putting p2 in the queue.
  const { meetingId, server, store } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, p1] = clients;

  // p2 opens tab A and queues, then opens tab B for the same account while still
  // queued — enqueue() refreshes the one queue entry in place, so it now points
  // at tab B's socket even though tab A is still connected.
  const tabA = connectClient(server.url, 'p2');
  clients.push(tabA);
  const waitingA = waitForEvent(tabA, 'meeting:waiting');
  tabA.emit('meeting:join-request', { meetingId });
  await waitingA;

  const tabB = connectClient(server.url, 'p2');
  clients.push(tabB);
  const waitingB = waitForEvent(tabB, 'meeting:waiting');
  tabB.emit('meeting:join-request', { meetingId });
  await waitingB;

  // Tab A's now-stale connection drops (a network blip finally timing out).
  // It must not evict tab B's queue entry.
  tabA.disconnect();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await store.queuedEntries(meetingId)).length, 1);
  assert.equal(await store.queueSocketId(meetingId, 'p2'), tabB.id);

  // When a seat frees, tab B — not the dropped tab A — is the one admitted.
  const admittedB = waitForEvent(tabB, 'meeting:admitted');
  p1.emit('meeting:leave');
  await admittedB;
});

test('manual mode: the host sees the lobby, admits and denies', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // The host's own join broadcasts its own (empty) lobby update over this same
  // socket, right after admission — drain it now so a later 'lobby:update'
  // listener below can't race and catch this stale one instead.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  const c1 = connectClient(server.url, 'p1');
  clients.push(c1);
  let lobby = waitForEvent(host, 'lobby:update');
  const waiting = waitForEvent(c1, 'meeting:waiting');
  c1.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await waiting, { position: 1, manual: true });
  assert.deepEqual((await lobby).waiting, [{ userId: 'p1', name: 'Priya One', imageUrl: null }]);

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  lobby = waitForEvent(host, 'lobby:update');
  // c2's own join broadcasts its initial position over its own socket, a
  // connection independent of the host's — consume it now so the next
  // 'meeting:waiting' listener below can't race and catch this stale one.
  const c2Waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  assert.deepEqual((await lobby).waiting.map((w) => w.userId), ['p1', 'p2']);
  assert.deepEqual(await c2Waiting, { position: 2, manual: true });

  // Admit p1.
  const admitted = waitForEvent(c1, 'meeting:admitted');
  // p2 moves up to position 1 as the queue shifts.
  const moved = waitForEvent(c2, 'meeting:waiting');
  host.emit('lobby:admit', { userId: 'p1' });
  await admitted;
  assert.deepEqual(await moved, { position: 1, manual: true });

  // Deny p2.
  const denied = waitForEvent(c2, 'meeting:denied');
  lobby = waitForEvent(host, 'lobby:update');
  host.emit('lobby:deny', { userId: 'p2' });
  assert.deepEqual(await denied, { reason: 'denied' });
  assert.deepEqual((await lobby).waiting, []);
});

test('manual mode: admitting into a full ZyloRoom is refused, and they stay in the lobby', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  for (const userId of ['p1', 'p2', 'p3']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const waiting = waitForEvent(c, 'meeting:waiting');
    c.emit('meeting:join-request', { meetingId });
    await waiting;
  }
  const [, c1, c2, c3] = clients;

  for (const [client, userId] of [[c1, 'p1'], [c2, 'p2']]) {
    const admitted = waitForEvent(client, 'meeting:admitted');
    host.emit('lobby:admit', { userId });
    await admitted;
  }

  // max is 3 (host + 2), so the third admit must be refused.
  const ack = await new Promise((resolve) => host.emit('lobby:admit', { userId: 'p3' }, resolve));
  assert.deepEqual(ack, { ok: false, reason: 'full' });
  assert.equal(await store.hasSeat(meetingId, 'p3'), false);
  assert.deepEqual((await store.queuedEntries(meetingId)).map((e) => e.userId), ['p3']);
  c3.disconnect();
});

test('a non-host lobby:admit is forbidden', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // The host's own join broadcasts its own (empty) lobby update over this same
  // socket, right after admission — drain it now so the 'queued' listener
  // below can't race and catch this stale one instead of p1's real one.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  // Wait for p1 to actually reach the lobby before admitting: emitting both back
  // to back would race the host's admit past the join request.
  const c1 = connectClient(server.url, 'p1');
  clients.push(c1);
  const queued = waitForEvent(host, 'lobby:update');
  c1.emit('meeting:join-request', { meetingId });
  await queued;

  const admitted = waitForEvent(c1, 'meeting:admitted');
  host.emit('lobby:admit', { userId: 'p1' });
  await admitted;

  const c2 = connectClient(server.url, 'p2');
  clients.push(c2);
  const waiting = waitForEvent(c2, 'meeting:waiting');
  c2.emit('meeting:join-request', { meetingId });
  await waiting;

  const forbidden = waitForEvent(c1, 'error:forbidden');
  c1.emit('lobby:admit', { userId: 'p2' });
  await forbidden;
  assert.equal(await store.hasSeat(meetingId, 'p2'), false);

  // A waiting user has a meetingId too, and is just as forbidden.
  const forbiddenAgain = waitForEvent(c2, 'error:forbidden');
  c2.emit('host:set-admission', { mode: 'auto' });
  await forbiddenAgain;
});

test('switching manual to auto drains the lobby in order until seats run out', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // The host's own join broadcasts its own (empty) lobby update over this same
  // socket, right after admission — drain it now, and drain each loop
  // iteration's lobby update below in lockstep, so the 'lobby:update' listener
  // set up after the loop can't race and catch a stale one of these instead.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  for (const userId of ['p1', 'p2', 'p3']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const waiting = waitForEvent(c, 'meeting:waiting');
    const hostLobby = waitForEvent(host, 'lobby:update');
    c.emit('meeting:join-request', { meetingId });
    await waiting;
    await hostLobby;
  }
  const [, c1, c2, c3] = clients;

  const settings = waitForEvent(host, 'meeting:settings');
  const first = waitForEvent(c1, 'meeting:admitted');
  const second = waitForEvent(c2, 'meeting:admitted');
  const stillWaiting = waitForEvent(c3, 'meeting:waiting');
  const lobby = waitForEvent(host, 'lobby:update');
  host.emit('host:set-admission', { mode: 'auto' });

  assert.deepEqual(await settings, { admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: true, aiNudges: false });
  await Promise.all([first, second]);
  assert.deepEqual(await stillWaiting, { position: 1, manual: false });
  assert.deepEqual((await lobby).waiting.map((w) => w.userId), ['p3']);

  const { rows } = await db.query('SELECT admission FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].admission, 'auto');
});

test('everyone leaving ends the meeting in the database', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  const c1 = connectClient(server.url, 'p1');
  clients.push(host, c1);
  for (const c of clients) {
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }

  const gone = waitForEvent(host, 'disconnect');
  c1.emit('meeting:leave');
  await new Promise((r) => setTimeout(r, 50));
  host.emit('meeting:leave');
  await gone;
  await new Promise((r) => setTimeout(r, 50));

  const { rows } = await db.query('SELECT started_at, ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].started_at, null);
  assert.notEqual(rows[0].ended_at, null);

  const participants = await db.query(
    'SELECT user_id, role FROM meeting_participants WHERE meeting_id = $1 ORDER BY user_id',
    [meetingId],
  );
  assert.deepEqual(participants.rows, [
    { user_id: 'host', role: 'host' },
    { user_id: 'p1', role: 'participant' },
  ]);
});

// A second live meeting, only for the cross-meeting leak test — inserted
// alongside MEETING_ID and cleared alongside it in that test's t.after.
const OTHER_MEETING_ID = 'klm-nopq-rst';

test('ZyloChat reaches seated members only, with the name taken from the seat', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db, { admission: 'manual' });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  // Drain the host's own (empty) lobby update, same as the other manual-mode
  // tests, so it can't be caught by a later 'lobby:update' listener.
  const hostOwnLobby = waitForEvent(host, 'lobby:update');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;
  await hostOwnLobby;

  const p1 = connectClient(server.url, 'p1');
  clients.push(p1);
  const p1Waiting = waitForEvent(p1, 'meeting:waiting');
  const hostLobby = waitForEvent(host, 'lobby:update');
  p1.emit('meeting:join-request', { meetingId });
  await p1Waiting;
  await hostLobby;

  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  host.emit('lobby:admit', { userId: 'p1' });
  await p1Admitted;

  const p2 = connectClient(server.url, 'p2');
  clients.push(p2);
  const p2Waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await p2Waiting;

  // Listeners go up before the emit, and we settle on a timer rather than
  // waitForEvent — p2 not receiving anything can't be proven by a race.
  const hostChat = [];
  const p1Chat = [];
  const p2Chat = [];
  host.on('chat:message', (m) => hostChat.push(m));
  p1.on('chat:message', (m) => p1Chat.push(m));
  p2.on('chat:message', (m) => p2Chat.push(m));

  // userId/name in the payload are forged; the server must ignore them and use
  // the seat's own identity instead.
  p1.emit('chat:message', { text: '  hello ZyloRoom  ', userId: 'host', name: 'Impostor' });
  await new Promise((r) => setTimeout(r, 60));

  // The broadcast reaches the sender too, so p1 gets its own message once.
  assert.equal(hostChat.length, 1);
  assert.equal(p1Chat.length, 1);
  assert.equal(p2Chat.length, 0);
  assert.deepEqual(hostChat[0], p1Chat[0]);
  assert.equal(hostChat[0].userId, 'p1');
  assert.equal(hostChat[0].name, 'Priya One');
  assert.equal(hostChat[0].text, 'hello ZyloRoom');
  assert.equal(typeof hostChat[0].ts, 'number');
});

test('a waiting user cannot send ZyloChat', async (t) => {
  const db = await setupTestDb();
  // max 2 so host + p1 fill the one non-host slot, putting p2 in the queue
  // with socket.data.meetingId set but no seat — the case the handler must
  // not trust.
  const { meetingId, server } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [host, p1] = clients;

  const p2 = connectClient(server.url, 'p2');
  clients.push(p2);
  const waiting = waitForEvent(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  await waiting;

  const hostChat = [];
  const p1Chat = [];
  host.on('chat:message', (m) => hostChat.push(m));
  p1.on('chat:message', (m) => p1Chat.push(m));

  p2.emit('chat:message', { text: 'let me in' });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(hostChat.length, 0);
  assert.equal(p1Chat.length, 0);
});

test('ZyloChat drops everything that fails validation, silently', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const admitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await admitted;

  const chat = [];
  const forbidden = [];
  const denied = [];
  host.on('chat:message', (m) => chat.push(m));
  host.on('error:forbidden', (m) => forbidden.push(m));
  host.on('meeting:denied', (m) => denied.push(m));

  host.emit('chat:message', {});
  host.emit('chat:message', { text: 42 });
  host.emit('chat:message', { text: '   ' });
  host.emit('chat:message', { text: 'x'.repeat(2001) });
  host.emit('chat:message', { text: 'y'.repeat(2000) });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(chat.length, 1);
  assert.equal(chat[0].text.length, 2000);
  assert.equal(forbidden.length, 0);
  assert.equal(denied.length, 0);
});

test("a message never reaches a different meeting's ZyloRoom", async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  await insertMeeting(db, { id: OTHER_MEETING_ID, hostId: 'p2', admission: 'auto', maxParticipants: 3 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const other = connectClient(server.url, 'p2');
  clients.push(other);
  const otherAdmitted = waitForEvent(other, 'meeting:admitted');
  other.emit('meeting:join-request', { meetingId: OTHER_MEETING_ID });
  await otherAdmitted;

  const hostChat = [];
  const otherChat = [];
  host.on('chat:message', (m) => hostChat.push(m));
  other.on('chat:message', (m) => otherChat.push(m));

  host.emit('chat:message', { text: 'hello meeting A' });
  await new Promise((r) => setTimeout(r, 60));

  // Prove isolation, not just silence: the message must actually land inside
  // meeting A, or a handler that silently drops everything would pass this too.
  assert.equal(hostChat.length, 1);
  assert.equal(otherChat.length, 0);
});

test('a tab that was replaced cannot post to ZyloChat', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const first = connectClient(server.url, 'p1');
  clients.push(first);
  const firstAdmitted = waitForEvent(first, 'meeting:admitted');
  first.emit('meeting:join-request', { meetingId });
  await firstAdmitted;

  const second = connectClient(server.url, 'p1');
  clients.push(second);
  const replaced = waitForEvent(first, 'meeting:replaced');
  const secondAdmitted = waitForEvent(second, 'meeting:admitted');
  second.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, secondAdmitted]);

  const hostChat = [];
  host.on('chat:message', (m) => hostChat.push(m));

  first.emit('chat:message', { text: 'from the replaced tab' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(hostChat.length, 0);

  second.emit('chat:message', { text: 'from the active tab' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(hostChat.length, 1);
  assert.equal(hostChat[0].text, 'from the active tab');
});

// Pins the seat.socketId !== socket.id guard by itself, deterministically. In the
// real join path the store's join script moves the seat to the new socket, and the
// old socket's socket.data.meetingId is never cleared (it may live on another
// server): the socketId check is the only thing that stops a replaced tab acting.
// Here we recreate that directly: take the seat over in the store, bypassing the
// join handler entirely, so p1's original socket keeps its meetingId. If
// seat.socketId !== socket.id were ever deleted from the handler, this is the test
// that would catch it.
test('a socket the seat no longer points at cannot post', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connectClient(server.url, 'p1');
  clients.push(p1);
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  // Repoint the seat to a synthetic socket without going through admit(), so
  // p1's real socket keeps socket.data.meetingId set even though the seat no
  // longer points at it.
  await takeOverSeat(store, meetingId, 'p1', 'synthetic-other-tab');
  assert.equal((await store.seatFor(meetingId, 'p1')).socketId, 'synthetic-other-tab');

  const hostChat = [];
  host.on('chat:message', (m) => hostChat.push(m));

  p1.emit('chat:message', { text: 'stale socket, meetingId still set' });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(hostChat.length, 0);
});

test('a socket that never joined a meeting cannot post', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server } = await scenario(db);
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  const host = connectClient(server.url, 'host');
  clients.push(host);
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const ghost = connectClient(server.url, 'ghost');
  clients.push(ghost);
  await waitForEvent(ghost, 'connect');

  const hostChat = [];
  host.on('chat:message', (m) => hostChat.push(m));

  ghost.emit('chat:message', { text: 'hello' });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(hostChat.length, 0);
});

// A lobby entry whose tab has already closed but whose entry is still queued (its
// disconnect not yet handled, or handled on another server): put in the store directly.
const closedTabEntry = { userId: 'p2', socketId: 'closed-tab', name: 'Pablo Two', imageUrl: null, lang: null };

test('auto mode: a seat drained to a tab that already closed goes on to the next in the lobby', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [, p1] = clients;
  assert.equal((await store.join(meetingId, closedTabEntry, { isHost: false })).result, 'queued');
  const p3 = connectClient(server.url, 'p3');
  clients.push(p3);
  const waiting = waitForEvent(p3, 'meeting:waiting');
  p3.emit('meeting:join-request', { meetingId });
  await waiting;

  const admitted = [];
  p3.on('meeting:admitted', () => admitted.push(true));
  p1.emit('meeting:leave');
  await settle(300);

  assert.equal(admitted.length, 1);
  assert.equal(await store.hasSeat(meetingId, 'p2'), false);
  assert.equal(await store.hasSeat(meetingId, 'p3'), true);
});

test('auto mode: the host admitting a tab that already closed hands the seat to the next in the lobby', async (t) => {
  const db = await setupTestDb();
  const { meetingId, server, store } = await scenario(db, { maxParticipants: 2 });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });

  for (const userId of ['host', 'p1']) {
    const c = connectClient(server.url, userId);
    clients.push(c);
    const admitted = waitForEvent(c, 'meeting:admitted');
    c.emit('meeting:join-request', { meetingId });
    await admitted;
  }
  const [host] = clients;
  assert.equal((await store.join(meetingId, closedTabEntry, { isHost: false })).result, 'queued');
  const p3 = connectClient(server.url, 'p3');
  clients.push(p3);
  const waiting = waitForEvent(p3, 'meeting:waiting');
  p3.emit('meeting:join-request', { meetingId });
  await waiting;

  // A seat frees without the handlers' drain (as if that call had not run yet).
  await store.releaseSeat(meetingId, 'p1');
  const admitted = [];
  p3.on('meeting:admitted', () => admitted.push(true));
  const ack = await new Promise((resolve) => host.emit('lobby:admit', { userId: 'p2' }, resolve));
  await settle(300);

  assert.deepEqual(ack, { ok: false, reason: 'gone' });
  assert.equal(admitted.length, 1);
  assert.equal(await store.hasSeat(meetingId, 'p3'), true);
});

// The sweeper's clearIfIdle can run between a join's meta load and its seat script (the
// join makes two or three Postgres queries in between), so a join must renew an existing
// room's age, not only a room it creates.
test('a join into a room that sat idle renews its age, so the sweeper cannot clear it before the seat', async (t) => {
  let clearedMidJoin;
  const decorateStore = (real) => ({
    ...real,
    join: async (...args) => {
      clearedMidJoin = await real.clearIfIdle(args[0], 250); // the sweep, just before the seat script
      return real.join(...args);
    },
  });
  const { meetingId, connect, store } = await roomHarness(t, { decorateStore });
  // A room with nobody in it, older than the idle limit: a manual meeting whose early guest left.
  await store.initMeta(meetingId, {
    hostId: 'host', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 3, mode: 'standard',
  });
  await settle(300);

  const p1 = connect('p1');
  const admitted = collect(p1, 'meeting:admitted');
  const denied = collect(p1, 'meeting:denied');
  p1.emit('meeting:join-request', { meetingId });
  await settle(300);

  assert.equal(clearedMidJoin, false);
  assert.deepEqual(denied, []);
  assert.equal(admitted.length, 1);
  assert.equal(await store.hasSeat(meetingId, 'p1'), true);
});

test('a guest leaving the lobby does not end the meeting for the others still waiting', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { admission: 'manual' }); // no host yet
  const [w1, w2] = [connect('p1'), connect('p2')];
  for (const c of [w1, w2]) {
    const waiting = waitForEvent(c, 'meeting:waiting');
    c.emit('meeting:join-request', { meetingId });
    await waiting;
  }
  const denied = collect(w2, 'meeting:denied');
  const waiting = collect(w2, 'meeting:waiting');

  w1.emit('meeting:leave');
  await settle(200);

  assert.deepEqual(denied, []);
  assert.deepEqual(waiting, [{ position: 1, manual: true }], 'w2 moves up');
  assert.notEqual(await store.getMeta(meetingId), null, 'the room is still there');
  assert.equal(await store.queuePosition(meetingId, 'p2'), 1);
});

test('the last person leaving tells everyone still in the lobby the meeting ended', async (t) => {
  const { meetingId, connect, join, store } = await roomHarness(t, { admission: 'manual' });
  const host = await join('host');
  const w1 = connect('p1');
  const waiting = waitForEvent(w1, 'meeting:waiting');
  w1.emit('meeting:join-request', { meetingId });
  await waiting;
  const denied = collect(w1, 'meeting:denied');

  host.emit('meeting:leave');
  await settle(200);

  assert.deepEqual(denied, [{ reason: 'ended' }]);
  assert.equal(await store.getMeta(meetingId), null);
});

// A join can seat someone after the last person's leave has seen an empty room and
// before the room is cleared; the clear returns every socket it dropped, and each is told.
test('a join seated between the last person leaving and the room clearing is told, not wiped silently', async (t) => {
  let late; // the socket whose join lands in that gap
  const decorateStore = (real) => ({
    ...real,
    clearMeeting: async (...args) => {
      if (late) await real.join(args[0], { userId: 'p2', socketId: late.id, name: 'Pablo Two' }, { isHost: false });
      return real.clearMeeting(...args);
    },
  });
  const { connect, join } = await roomHarness(t, { decorateStore });
  const host = await join('host');
  late = connect('p2');
  await waitForEvent(late, 'connect');
  const denied = collect(late, 'meeting:denied');

  host.emit('meeting:leave');
  await settle(200);

  assert.deepEqual(denied, [{ reason: 'ended' }]);
});

// ── The "meeting ended" log line ────────────────────────────────────────────

// Each "meeting ended" line lib/log.js printed, as its key=value fields.
const meetingEndedLines = (logged) =>
  logged.mock.calls.filter((call) => call.arguments[0] === 'meeting ended').map((call) => call.arguments.slice(1));

test('End for all logs one "meeting ended" line with reason host', async (t) => {
  const logged = t.mock.method(console, 'log', () => {});
  const { meetingId, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const ended = Promise.all([host, p1].map((c) => waitForEvent(c, 'meeting:ended')));
  host.emit('host:end-meeting');
  await ended;
  await settle(150);
  assert.deepEqual(meetingEndedLines(logged), [[`meetingId=${meetingId}`, 'reason=host']]);
});

test('the last person leaving logs one "meeting ended" line with reason empty', async (t) => {
  const logged = t.mock.method(console, 'log', () => {});
  const { meetingId, join } = await roomHarness(t);
  const host = await join('host');
  const gone = waitForEvent(host, 'disconnect');
  host.emit('meeting:leave');
  await gone;
  await settle(150);
  assert.deepEqual(meetingEndedLines(logged), [[`meetingId=${meetingId}`, 'reason=empty']]);
});
