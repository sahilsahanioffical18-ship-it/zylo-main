const express = require('express');
const cors = require('cors');
const { meetingsRouter } = require('./lib/meetings');
const { googleRouter } = require('./lib/google');
const { livekitWebhook } = require('./lib/webhook');
const { createLimiter } = require('./lib/rateLimit');
const { limitRequests } = require('./lib/limitMiddleware');
const { log } = require('./lib/log');

// Both probes mean "can we actually reach it", not "is it configured" — a
// health endpoint that calls a configured-but-dead dependency healthy is a lie
// that costs an operator an hour.
// ponytail: neither probe has a timeout, matching the existing SELECT 1. If a
// wedged dependency ever hangs the probe, wrap both in
// Promise.race([p, AbortSignal.timeout(1000)]).
async function reachable(probe) {
  if (!probe) return false;
  try { await probe(); return true; } catch { return false; }
}

// `google` is only ever set by tests (a fake Google + a fresh cache) and server.js
// (the Redis cache). Without a `limiter`, one is made on `redis` (memory without it).
// `ai` (lib/ai.js; null when not configured) only feeds /health and the cards' aiAvailable.
function createApp({
  db,
  auth,
  livekit,
  redis = null,
  limiter = createLimiter({ redis }),
  trustProxy = 0,
  google = {},
  store = null,
  ai = null,
}) {
  const app = express();
  // TRUST_PROXY hops: behind our load balancer req.ip must be the client, not the
  // balancer, or every user would share one per-IP bucket.
  app.set('trust proxy', trustProxy);
  // exposedHeaders: without it the browser hides these two from the app's fetch().
  app.use(cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
    exposedHeaders: ['Retry-After', 'RateLimit-Remaining'],
  }));
  // Before express.json(), deliberately: the webhook verifies a signature over the
  // raw bytes. Outside /api, deliberately: Clerk cannot authenticate LiveKit. Before
  // the IP limit, deliberately: it is signed already, and dropping one could leave a
  // removed person in the room. Not mounted without LiveKit: no secret to verify with.
  if (livekit) app.use(livekitWebhook(livekit, store));
  app.use(limitRequests(limiter, 'ip', (req) => req.ip));
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', async (_req, res) => {
    const [dbOk, livekitOk, redisOk] = await Promise.all([
      reachable(db ? () => db.query('SELECT 1') : null),
      reachable(livekit ? () => livekit.ping() : null),
      reachable(redis ? () => redis.ping() : null),
    ]);
    // ai is the one that means "configured", not "reachable": asking the provider costs money.
    res.json({ ok: true, db: dbOk, livekit: livekitOk, redis: redisOk, ai: Boolean(ai) });
  });

  app.use('/api', (_req, res, next) => {
    if (!db) return res.status(503).json({ error: 'Database is not configured on the server (DATABASE_URL).' });
    next();
  });
  app.use('/api', auth);
  // After auth, so the bucket is the user's, whichever IP they come from.
  app.use('/api', limitRequests(limiter, 'api', (req) => req.userId));

  app.use('/api', googleRouter({ ...google, limiter })); // /api/tts and /api/translate
  if (db) app.use('/api', meetingsRouter(db, livekit, limiter, store, Boolean(ai)));

  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    // An unexpected failure: the stack is what finds the line. Never the request body.
    if (status >= 500) log.error('request failed', { userId: req.userId, err: err.message, stack: err.stack });
    res.status(status).json({
      error: status < 500 ? 'That request could not be read.' : 'Something went wrong on the server.',
    });
  });

  return app;
}

module.exports = { createApp };
