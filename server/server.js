require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createApp } = require('./app');
const { createDb } = require('./lib/db');
const { createLivekit } = require('./lib/livekit');
const { createRedis } = require('./lib/redis');
const { createLimiter } = require('./lib/rateLimit');
const { createRoomStore } = require('./lib/roomStore');
const { limitConnections } = require('./lib/limitMiddleware');
const { createCache, createRedisCache } = require('./lib/cache');
const { clerkAuth, clerkSocketAuth } = require('./lib/auth');
const { registerRoomHandlers } = require('./lib/room');
const { createAi } = require('./lib/ai');
const { createChatHistory } = require('./lib/chatHistory');
const { log } = require('./lib/log');
const { shutdown, onStopSignal } = require('./lib/shutdown');

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';

async function main() {
  // One id per process: seats and the screen lock record which server holds them, and
  // every JSON log line carries it.
  const serverId = randomUUID();
  log.base.serverId = serverId;
  const db = createDb(process.env.DATABASE_URL);
  if (!db) log.warn('WARNING: DATABASE_URL is not set — /api routes will return 503.');
  if (!process.env.CLERK_SECRET_KEY || !process.env.CLERK_PUBLISHABLE_KEY) {
    log.warn('WARNING: CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY are not set — /api routes will return 503.');
  }
  const livekit = createLivekit();
  if (!livekit) {
    log.warn(
      'WARNING: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not set — the LiveKit token route will return 503.',
    );
  }
  const redis = createRedis();
  if (!redis) log.warn("WARNING: REDIS_URL is not set — rate limits and the translation cache stay in this server's memory.");
  const limiter = createLimiter({ redis });
  const ai = createAi({ baseUrl: process.env.AI_BASE_URL, apiKey: process.env.AI_API_KEY, model: process.env.AI_MODEL });
  if (!ai) log.warn('WARNING: AI_API_KEY or AI_MODEL is not set — Ask AI is off.');
  const store = redis ? createRoomStore(redis, { serverId }) : null;
  // Proxy hops to trust for the client IP: a non-negative integer, else 0 (a bad value must not silently pass).
  const rawTrust = (process.env.TRUST_PROXY || '').trim();
  const validTrust = /^\d+$/.test(rawTrust);
  const trustProxy = validTrust ? Number(rawTrust) : 0;
  if (rawTrust && !validTrust) log.warn(`WARNING: TRUST_PROXY="${rawTrust}" is not a non-negative integer — using 0.`);

  if (db) {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
    } catch (err) {
      log.warn(`WARNING: could not apply db/schema.sql (${err.message}). Is Postgres running? Try: npm run db:up`);
    }
  }

  const app = createApp({
    db, auth: clerkAuth({ db }), livekit, redis, limiter, trustProxy, store, ai,
    google: { cache: redis ? createRedisCache(redis) : createCache() },
  });
  const httpServer = http.createServer(app);
  // WebSocket only, here and in the browser (use-meeting.ts): with no HTTP long-polling,
  // several API servers need no sticky sessions. A polling handshake gets a 400.
  const io = new Server(httpServer, { transports: ['websocket'], cors: { origin: CLIENT_ORIGIN } });
  // Every Redis connection this server opens, closed last on a planned stop.
  const redisClients = redis ? [redis] : [];
  if (redis) {
    // Two connections of its own with the offline queue on: the adapter subscribes at
    // start-up and must not fail just because Redis isn't connected yet. duplicate()
    // copies redis.js's 500 ms commandTimeout / 1 s socketTimeout, which would fail
    // that first subscribe, so both are cleared. redis.js already reports outages, so
    // their errors are not logged again.
    const pubSubOptions = { enableOfflineQueue: true, maxRetriesPerRequest: null, commandTimeout: undefined, socketTimeout: undefined };
    const pub = redis.duplicate(pubSubOptions);
    const sub = redis.duplicate(pubSubOptions);
    pub.on('error', () => {});
    sub.on('error', () => {});
    redisClients.push(pub, sub);
    io.adapter(createAdapter(pub, sub));
  }
  io.use(limitConnections(limiter, trustProxy)); // before auth: a flood never reaches token checks
  io.use(clerkSocketAuth({ db }));
  const handlers =
    db && store ? registerRoomHandlers(io, { db, livekit, store, history: createChatHistory(redis), limiter, ai }) : null;
  if (!handlers) {
    log.warn('WARNING: DATABASE_URL or REDIS_URL is not set — ZyloRoom sockets will refuse every join request.');
    // Refuse out loud: with no handler a client would wait on "connecting" for good.
    io.on('connection', (socket) =>
      socket.on('meeting:join-request', () => socket.emit('meeting:denied', { reason: 'unavailable' })),
    );
  }

  httpServer.listen(PORT, () =>
    log.info('Zylo API listening', { port: PORT, serverId, ai: Boolean(ai), redis: Boolean(redis), livekit: Boolean(livekit) }),
  );
  // SIGTERM (a redeploy) or Ctrl-C: hand everyone over to another server, then exit.
  onStopSignal(() => shutdown({ httpServer, io, handlers, redisClients, db }));
}

main();
