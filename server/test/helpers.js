const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../lib/db');
const http = require('node:http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { io: ioClient } = require('socket.io-client');
const { createRoomStore } = require('../lib/roomStore');
const { createChatHistory } = require('../lib/chatHistory');
const { createLimiter } = require('../lib/rateLimit');
const { registerRoomHandlers } = require('../lib/room');
const { createRedis, whenReady } = require('../lib/redis');

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Test-only auth: trusts the x-test-user header. Production always uses clerkAuth.
function fakeAuth(req, res, next) {
  const userId = req.get('x-test-user');
  if (!userId) return res.status(401).json({ error: 'Sign in required.' });
  req.userId = userId;
  next();
}

// The test database and Redis database 1: never the dev data.
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://zylo:zylo@localhost:5432/zylo_test';
const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';

async function setupTestDb() {
  const db = createDb(TEST_DATABASE_URL);
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  await db.query('TRUNCATE meeting_participants, meeting_invites, meetings, users');
  return db;
}

const quietLog = { warn: () => {} };

// For suites that test something else and would trip a real limit by volume alone.
const unlimitedLimiter = { take: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }) };

// A clean Redis connection the caller closes: database 1 (never the dev data in 0),
// emptied first. Needs `npm run db:up`. A dead Redis fails here and the client is
// closed on the way out, so it never keeps reconnecting and holds the test process open.
async function connectTestRedis() {
  const redis = createRedis(TEST_REDIS_URL, { log: quietLog });
  try {
    await whenReady(redis);
    await redis.flushdb();
  } catch (err) {
    redis.disconnect();
    throw err;
  }
  return redis;
}

// The same, closed when the test ends.
async function setupTestRedis(t) {
  const redis = await connectTestRedis();
  t.after(() => redis.disconnect());
  return redis;
}

// Test-only socket auth: trusts the handshake's userId. Production always uses
// clerkSocketAuth.
function fakeSocketAuth(socket, next) {
  const userId = socket.handshake.auth?.userId;
  if (!userId) return next(new Error('Sign in required.'));
  socket.data.userId = userId;
  next();
}

async function startSocketServer(configureIo) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { transports: ['websocket'] }); // WebSocket only, as in server.js
  configureIo(io);
  httpServer.listen(0);
  await new Promise((resolve) => httpServer.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${httpServer.address().port}`,
    httpServer,
    close: () =>
      new Promise((resolve) => {
        io.close();
        httpServer.close(resolve);
      }),
  };
}

function connectClient(url, userId) {
  return ioClient(url, { auth: { userId }, forceNew: true, transports: ['websocket'] });
}

function waitForEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function insertUser(db, { id, email, name, imageUrl = null }) {
  return db.query(
    `INSERT INTO users (id, email, name, image_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, email, name, imageUrl],
  );
}

function insertMeeting(
  db,
  { id, hostId, title = 'ZyloCall', admission = 'auto', screenSharePolicy = 'anyone', maxParticipants = 20, mode = 'standard' },
) {
  return db.query(
    `INSERT INTO meetings (id, host_id, title, admission, screen_share_policy, max_participants, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, hostId, title, admission, screenSharePolicy, maxParticipants, mode],
  );
}

// The four users and one meeting most socket tests need.
async function seedMeeting(
  db,
  { meetingId = 'abc-defg-hij', admission = 'auto', screenSharePolicy = 'anyone', maxParticipants = 3, mode = 'standard' } = {},
) {
  await insertUser(db, { id: 'host', email: 'host@zylo.test', name: 'Hana Host' });
  await insertUser(db, { id: 'p1', email: 'p1@zylo.test', name: 'Priya One' });
  await insertUser(db, { id: 'p2', email: 'p2@zylo.test', name: 'Pablo Two' });
  await insertUser(db, { id: 'p3', email: 'p3@zylo.test', name: 'Pia Three' });
  await insertMeeting(db, { id: meetingId, hostId: 'host', admission, screenSharePolicy, maxParticipants, mode });
  return meetingId;
}

// A Socket.IO server running the real room handlers on a room store. graceMs is
// short so grace expiry is testable. close() lets in-flight disconnect handling
// finish, stops the handlers' timers, closes the server, and lets the handling of
// any socket that closing it disconnected finish too, while Redis is still up.
// decorateStore wraps the store the handlers get (a test counting or delaying calls).
// adapter: true wires the Socket.IO Redis adapter, so several servers act as one. The
// sweep timers never run here; tests call handlers.sweep() themselves. The handlers get
// a chat history on the same Redis, returned for tests to read and seed. ai: a provider
// client (createAi against startFakeAi) or null. limiter: the real shared limits on this
// Redis unless a test passes its own (only ai:ask takes from it).
async function startRoomServer(
  db,
  redis,
  {
    serverId = 'server-a',
    graceMs = 60,
    livekit = null,
    adapter = false,
    decorateStore = (s) => s,
    ai = null,
    limiter = createLimiter({ redis, log: quietLog }),
  } = {},
) {
  const store = decorateStore(createRoomStore(redis, { serverId }));
  const history = createChatHistory(redis);
  // The adapter's own connections, with the offline queue on (as in server.js).
  // duplicate() copies redis.js's 500 ms commandTimeout / 1 s socketTimeout, which
  // would fail the adapter's SUBSCRIBE while the connection isn't ready yet: cleared.
  const pubsub = adapter
    ? [0, 1].map(() =>
        redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null, commandTimeout: undefined, socketTimeout: undefined }),
      )
    : [];
  let handlers;
  let socketServer;
  const server = await startSocketServer((io) => {
    socketServer = io; // for tests that watch what the handlers ask it
    if (adapter) io.adapter(createAdapter(pubsub[0], pubsub[1]));
    io.use(fakeSocketAuth);
    handlers = registerRoomHandlers(io, { db, graceMs, livekit, store, history, limiter, ai, sweepMs: 0 });
  });
  return {
    url: server.url,
    httpServer: server.httpServer,
    io: socketServer,
    pubsub, // the adapter's two connections, when adapter is true
    store,
    history,
    handlers,
    close: async () => {
      await settle();
      handlers.stop();
      await server.close();
      await settle();
      await Promise.all(pubsub.map((c) => c.quit()));
    },
  };
}

// A room server that owns its database pool, Redis connection and the adapter's two
// connections, as a real API server does, so shutdown() can close them and leave every
// other server in the test running. It joins the test database and Redis as they are (no
// truncate, no flush). cleanup() closes whatever is still open, after a shutdown() too:
// use it instead of close().
async function startOwnRoomServer(options = {}) {
  const redis = createRedis(TEST_REDIS_URL, { log: quietLog });
  await whenReady(redis).catch((err) => {
    redis.disconnect();
    throw err;
  });
  const db = createDb(TEST_DATABASE_URL);
  const room = await startRoomServer(db, redis, { ...options, adapter: true });
  await room.store.beat(); // alive, as its heartbeat would say
  const cleanup = async () => {
    room.handlers.stop();
    // Still serving: close it. After shutdown() it is closed, and a second close would
    // send the adapter's unsubscribe down a Redis connection that has already quit.
    if (room.httpServer.listening) await room.io.close();
    await room.handlers.drain(1_000); // the disconnect handlers closing it started, while Redis is up
    for (const client of [redis, ...room.pubsub]) client.disconnect();
    await db.close().catch(() => {}); // shutdown() may have closed it already
  };
  return { ...room, db, redis, cleanup };
}

// The four users, one meeting, and a room server. Brings its own Redis (closed by
// server.close()) unless one is passed in.
async function startRoom(db, { redis, serverId, graceMs = 60, livekit = null, decorateStore, ai, limiter, ...meeting } = {}) {
  const ownRedis = !redis;
  const conn = redis ?? (await connectTestRedis());
  let room;
  let meetingId;
  try {
    meetingId = await seedMeeting(db, meeting);
    room = await startRoomServer(db, conn, { serverId, graceMs, livekit, decorateStore, ai, limiter });
  } catch (err) {
    if (ownRedis) conn.disconnect(); // fail, don't leak
    throw err;
  }
  const close = async () => {
    try {
      await room.close();
    } finally {
      if (ownRedis) await conn.quit();
    }
  };
  return { meetingId, server: { url: room.url, close }, store: room.store, history: room.history, handlers: room.handlers };
}

// Connects userId and resolves once they hold a seat.
async function seat(url, userId, meetingId) {
  const client = connectClient(url, userId);
  const admitted = waitForEvent(client, 'meeting:admitted');
  client.emit('meeting:join-request', { meetingId });
  await admitted;
  return client;
}

// Every `event` a socket receives. Register before the emit under test, and read
// it after settle(): proving something did NOT arrive needs a window, not a race.
function collect(socket, event) {
  const got = [];
  socket.on(event, (payload) => got.push(payload));
  return got;
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// Stands in for lib/livekit.js: records each enforcement call, touches no network.
function recordingLivekit() {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    callsTo: (name) => calls.filter(([n]) => n === name).map(([, ...args]) => args),
    evict: record('evict'),
    grantScreenShare: record('grantScreenShare'),
    revokeScreenShare: record('revokeScreenShare'),
    muteMic: record('muteMic'),
    endRoom: record('endRoom'),
  };
}

// Stands in for an OpenAI-compatible chat API (xAI, NVIDIA): a local http server that
// records every request ({ url, headers, body }) and answers with respond(res, request).
// Closed when the test ends, cutting any answer still hanging.
async function startFakeAi(t, respond = aiAnswer(['Hello', ' there.'])) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const request = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    requests.push(request);
    await respond(res, request);
  });
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

// One streamed piece of an answer, as these APIs send it.
const aiPiece = (content) => ({ choices: [{ index: 0, delta: { content } }] });

// A respond function: 200, then each event as a server-sent `data:` line (objects as
// JSON, strings as they are), gapMs apart, then the end of the body.
function sseReply(events, { gapMs = 0 } = {}) {
  return async (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) {
      res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
      if (gapMs) await settle(gapMs);
    }
    res.end();
  };
}

// The usual answer: the pieces, then [DONE].
const aiAnswer = (pieces, options) => sseReply([...pieces.map(aiPiece), '[DONE]'], options);

// Takes ZyloLive for `client`, then lets the grant's broadcast settle.
async function shareScreen(client) {
  const granted = waitForEvent(client, 'screen:granted');
  client.emit('screen:request');
  await granted;
  await settle();
}

// One test's whole world — fresh DB, real handlers, recording LiveKit — torn down in t.after.
async function roomHarness(t, options = {}) {
  const db = await setupTestDb();
  const livekit = recordingLivekit();
  const { meetingId, server, store, history, handlers } = await startRoom(db, { ...options, livekit });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });
  const connect = (userId) => { const c = connectClient(server.url, userId); clients.push(c); return c; };
  const join = async (userId) => { const c = await seat(server.url, userId, meetingId); clients.push(c); return c; };
  return { db, livekit, meetingId, server, store, history, handlers, connect, join };
}

// Two room servers sharing one Redis and one database, like two API servers behind a
// load balancer. A client picks its server by which one it connects to.
async function twoServerHarness(t, { ai = null, ...meeting } = {}) {
  const db = await setupTestDb();
  const redis = await connectTestRedis();
  const livekit = recordingLivekit();
  const meetingId = await seedMeeting(db, meeting);
  const a = await startRoomServer(db, redis, { serverId: 'server-a', livekit, adapter: true, ai });
  const b = await startRoomServer(db, redis, { serverId: 'server-b', livekit, adapter: true, ai });
  await Promise.all([a.store.beat(), b.store.beat()]);
  await settle(200); // let both adapters' subscriptions land
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await a.close();
    await b.close();
    await redis.quit();
    await db.close();
  });
  const clientsOf = (server) => ({
    connect: (userId) => {
      const c = connectClient(server.url, userId);
      clients.push(c);
      return c;
    },
    join: async (userId) => {
      const c = await seat(server.url, userId, meetingId);
      clients.push(c);
      return c;
    },
  });
  return { db, redis, livekit, meetingId, a: { ...a, ...clientsOf(a) }, b: { ...b, ...clientsOf(b) } };
}

// Another tab taking this user's seat, as the real join path does it.
async function takeOverSeat(store, meetingId, userId, socketId) {
  const s = await store.seatFor(meetingId, userId);
  return store.join(meetingId, { userId, socketId, name: s.name, imageUrl: s.imageUrl, lang: s.lang }, { isHost: s.isHost });
}

// A seat with no socket server behind it, for HTTP routes that only read the store.
async function seatInStore(store, meetingId, { userId, socketId = `${userId}-socket`, name = userId, isHost = false }) {
  await store.initMeta(meetingId, {
    hostId: isHost ? userId : 'host', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 20, mode: 'standard',
  });
  return store.join(meetingId, { userId, socketId, name, imageUrl: null, lang: null }, { isHost });
}

module.exports = {
  listen,
  fakeAuth,
  setupTestDb,
  connectTestRedis,
  setupTestRedis,
  quietLog,
  unlimitedLimiter,
  fakeSocketAuth,
  startSocketServer,
  connectClient,
  waitForEvent,
  insertUser,
  insertMeeting,
  seedMeeting,
  startRoomServer,
  startOwnRoomServer,
  startRoom,
  seat,
  collect,
  settle,
  recordingLivekit,
  startFakeAi,
  aiPiece,
  sseReply,
  aiAnswer,
  roomHarness,
  twoServerHarness,
  shareScreen,
  takeOverSeat,
  seatInStore,
};
