const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAi } = require('../lib/ai');
const { shutdown, onStopSignal } = require('../lib/shutdown');
const {
  setupTestDb,
  connectTestRedis,
  seedMeeting,
  startOwnRoomServer,
  connectClient,
  seat,
  waitForEvent,
  collect,
  settle,
  startFakeAi,
  aiPiece,
} = require('./helpers');

// Records every line instead of printing it.
function recordingLog() {
  const lines = [];
  const at = (level) => (msg, fields = {}) => lines.push({ level, msg, ...fields });
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

// Two API servers on one Redis and one database, each owning its connections like a real
// process, so stopping A leaves B running. The grace period is the real 30 s: a seat
// must still be held after the stop. decorateA wraps server A's store.
async function twoServers(t, { ai = null, decorateA, ...meeting } = {}) {
  const db = await setupTestDb(); // emptied; the test seeds and reads through it
  const redis = await connectTestRedis(); // emptied; the test reads through it
  const meetingId = await seedMeeting(db, meeting);
  const a = await startOwnRoomServer({ serverId: 'server-a', ai, graceMs: 30_000, decorateStore: decorateA });
  const b = await startOwnRoomServer({ serverId: 'server-b', ai, graceMs: 30_000 });
  await settle(200); // let both adapters' subscriptions land
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await a.cleanup();
    await b.cleanup();
    await redis.quit();
    await db.close();
  });
  const connect = (server, userId) => {
    const c = connectClient(server.url, userId);
    clients.push(c);
    return c;
  };
  const join = async (server, userId) => {
    const c = await seat(server.url, userId, meetingId);
    clients.push(c);
    return c;
  };
  // Server A's planned stop, as server.js runs it on SIGTERM.
  const stopA = (overrides = {}, timing) =>
    shutdown(
      {
        httpServer: a.httpServer,
        io: a.io,
        handlers: a.handlers,
        redisClients: [a.redis, ...a.pubsub],
        db: a.db,
        log: recordingLog(),
        ...overrides,
      },
      timing,
    );
  return { redis, meetingId, a, b, connect, join, stopA };
}

const seatIn = async (redis, meetingId, userId) => JSON.parse(await redis.hget(`zylo:room:{${meetingId}}:seats`, userId));

test('a planned stop hands a seated person over: their transport closes, the seat is held, and they take it back on the other server', async (t) => {
  const { redis, meetingId, a, b, connect, join, stopA } = await twoServers(t); // max 3: the host + 2
  await join(b, 'host');
  await join(b, 'p2');
  const p1 = await join(a, 'p1');
  const before = await seatIn(redis, meetingId, 'p1');
  const reason = waitForEvent(p1, 'disconnect');

  assert.equal(await stopA(), 0);
  assert.equal(await reason, 'transport close', 'not "io server disconnect", which would stop the browser reconnecting');
  p1.disconnect(); // it would keep retrying server A; a load balancer sends the browser to B
  assert.ok((await seatIn(redis, meetingId, 'p1')).graceUntil > Date.now(), 'held: stamped before Redis closed');

  // The seat is still taken: a newcomer waits in the lobby.
  const p3 = connect(b, 'p3');
  const queued = waitForEvent(p3, 'meeting:waiting');
  p3.emit('meeting:join-request', { meetingId });
  await queued;

  // Back on server B: straight into the same seat, no lobby, no "full".
  const back = connect(b, 'p1');
  const waiting = collect(back, 'meeting:waiting');
  const denied = collect(back, 'meeting:denied');
  const admitted = waitForEvent(back, 'meeting:admitted');
  back.emit('meeting:join-request', { meetingId });
  await admitted;
  const after = await b.store.seatFor(meetingId, 'p1');
  assert.equal(after.seq, before.seq, 'the same seat, in the same place in the roster');
  assert.equal(after.serverId, 'server-b');
  assert.equal(after.graceUntil, undefined);
  await settle();
  assert.deepEqual([waiting, denied], [[], []]);
});

test('an Ask AI answer still streaming ends with ai:failed for the whole room, on both servers', async (t) => {
  t.mock.method(console, 'error', () => {}); // the aborted answer is logged, on purpose
  const provider = await startFakeAi(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(aiPiece('Let me think'))}\n\n`); // ...and never finishes
  });
  const ai = createAi({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model' });
  const { a, b, join, stopA } = await twoServers(t, { ai });
  const host = await join(b, 'host');
  const p1 = await join(a, 'p1');
  const streaming = waitForEvent(host, 'ai:chunk');
  // null if it never comes: a missing ai:failed fails the assertion, not the whole file.
  const failedOn = (client) => Promise.race([waitForEvent(client, 'ai:failed'), settle(2_000).then(() => null)]);
  const failed = Promise.all([host, p1].map(failedOn));
  const done = [collect(host, 'ai:done'), collect(p1, 'ai:done')];
  p1.emit('ai:ask', { text: 'What should we decide?' });
  const { id } = await streaming;

  assert.equal(await stopA(), 0);
  const [forHost, forP1] = await failed;
  assert.equal(forHost?.id, id);
  assert.equal(forP1?.id, id, 'it reached the asker on server A before their connection closed');
  await settle();
  assert.deepEqual(done, [[], []]);
});

test('the stop stops the handlers, closes Redis (all three connections) and Postgres, logs each step, and resolves to 0', async (t) => {
  const { a, stopA } = await twoServers(t);
  const stop = t.mock.method(a.handlers, 'stop');
  const log = recordingLog();

  assert.equal(await stopA({ log }), 0);
  assert.equal(stop.mock.callCount(), 1, 'timers, grace timers and AI calls stopped');
  assert.equal(a.httpServer.listening, false);
  await settle();
  assert.deepEqual([a.redis, ...a.pubsub].map((client) => client.status), ['end', 'end', 'end']);
  await assert.rejects(a.db.query('SELECT 1'));
  assert.deepEqual(log.lines.map((line) => line.msg), [
    'shutting down',
    'shutdown: timers and AI stopped',
    'shutdown: connections closed',
    'shutdown: redis and postgres closed',
    'shutdown complete',
  ]);
  assert.equal(log.lines[2].handlersDone, true);
  assert.equal(typeof log.lines[4].ms, 'number');
});

test('a handler that never finishes holds the stop no longer than the drain', async (t) => {
  let hang = false;
  const decorateA = (s) => ({ ...s, seatFor: (...args) => (hang ? new Promise(() => {}) : s.seatFor(...args)) });
  const { a, join, stopA } = await twoServers(t, { decorateA });
  const p1 = await join(a, 'p1');
  hang = true;
  p1.emit('chat:message', { text: 'this handler never finishes' });
  await settle();
  assert.equal(await a.handlers.drain(50), false, 'the chat handler is stuck');
  const log = recordingLog();
  const started = Date.now();

  assert.equal(await stopA({ log }, { drainMs: 300, watchdogMs: 5_000 }), 0);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
  assert.equal(log.lines.find((line) => line.msg === 'shutdown: connections closed').handlersDone, false);
});

test('the watchdog resolves to 1 when the whole stop overruns', async (t) => {
  const { a, stopA } = await twoServers(t);
  const log = recordingLog();
  const hangingDb = { ...a.db, close: () => new Promise(() => {}) };
  const started = Date.now();

  assert.equal(await stopA({ db: hangingDb, log }, { drainMs: 100, watchdogMs: 400 }), 1);
  assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
  assert.deepEqual(log.lines.at(-1), { level: 'error', msg: 'shutdown timed out', ms: log.lines.at(-1).ms });
});

test('the first SIGTERM or SIGINT starts one stop and exits with its code; another signal meanwhile does nothing', async () => {
  const target = new EventEmitter();
  const exits = [];
  let stops = 0;
  let finish;
  const stop = () => {
    stops += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  onStopSignal(stop, { target, exit: (code) => exits.push(code) });
  target.emit('SIGTERM');
  target.emit('SIGINT');
  target.emit('SIGTERM');
  assert.equal(stops, 1);
  assert.deepEqual(exits, []);
  finish(0);
  await settle(0);
  assert.deepEqual(exits, [0]);
});
