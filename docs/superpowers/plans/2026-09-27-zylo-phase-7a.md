# Zylo Phase 7a: Redis and rate limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis to Zylo and put a token-bucket rate limit on every HTTP route, every socket connection and every socket event that needs one, and move the translation cache into Redis.

**Architecture:** One token-bucket algorithm. Limits shared across servers (per IP, per user, whole deployment) run as a Redis Lua script and fall back to per-server memory when Redis is down; per-socket event limits stay in memory on the socket. Express gets a small middleware that sets `RateLimit-Remaining` and answers `429` with `Retry-After`. The Google proxy draws on the same limiter, and its cache moves to Redis behind the same async `get`/`set`.

**Tech Stack:** Node 22, Express 5, Socket.IO 4.8, ioredis 5, Redis 7 (Docker), node:test; web: Next.js 16, React 19, sonner toasts.

**Spec:** `docs/superpowers/specs/2026-09-27-zylo-phase-7-redis-design.md`

## Global Constraints

- Start only after Phase 6 is approved and merged into `main`. Work in a new worktree `.worktrees/phase-7-redis` on branch `phase-7-redis` created from `main` (use superpowers:using-git-worktrees).
- Execution model: Sonnet subagents write the code (the user's standing workflow); the orchestrating session reviews each task.
- Every Redis key starts with `zylo:`. Rate-limit keys are `zylo:rl:<policy>:<id>`; cache keys are `zylo:cache:<tts|tr>:<sha1>`.
- The numbers in `POLICIES` and `SOCKET_POLICIES` (Task 2) are exactly the spec's tables; change them only in `server/lib/rateLimit.js`.
- Rate limits fail **open** to per-server memory when Redis errors; the cache treats errors as misses. Nothing in 7a may fail a request because Redis is down.
- `POST /livekit/webhook` is never rate limited.
- The 429 body is exactly `{ error: "Too many requests. Try again in N s.", retryAfterMs }` with header `Retry-After: N` (N = whole seconds, at least 1).
- Never `git add -A`; stage the files each task names. Never commit `server/.env` or `web/.env.local`. Don't push unless the user asks.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the attribution line the session gives you).
- Tests need Postgres and Redis running: `npm run db:up` from the repo root (Task 1 makes it start both).
- Server tests: `cd server && npm test`. One file: `cd server && node --test test/<file>.test.js`. Web: `cd web && npm test && npx tsc --noEmit && npm run lint`.

## File map

| File | Responsibility |
|---|---|
| `docker-compose.yml`, `package.json` (root) | Local Redis beside Postgres |
| `server/lib/redis.js` (new) | The one Redis connection: fail-fast options, outage logging, `whenReady` |
| `server/lib/rateLimit.js` (new) | Token bucket (`takeToken`), the Lua script, `createLimiter`, `POLICIES`, `SOCKET_POLICIES` |
| `server/lib/limitMiddleware.js` (new) | Express `limitRequests`, `sendTooMany`, `forwardedIp`, Socket.IO `limitConnections` |
| `server/lib/cache.js` | Adds `createRedisCache` beside the in-memory `createCache` |
| `server/lib/google.js` | Upstream budget from the shared limiter instead of in-process Maps |
| `server/lib/captionRules.js` | Loses its rate-limit code (moved to `rateLimit.js`) |
| `server/lib/room.js` | Per-socket event buckets, `rate-limited` event |
| `server/lib/meetings.js` | Route limits on create, lookup and LiveKit token |
| `server/app.js`, `server/server.js` | Wiring: trust proxy, IP and per-user limits, exposed headers, `/health.redis` |
| `web/lib/rate-limit.ts` (new) | Toast wording per refused event; connect retry delay |
| `web/lib/use-meeting.ts` | Shows `rate-limited` toasts; retries a refused connection after the wait |

---

### Task 1: Redis in development, the client, and `/health`

**Files:**
- Modify: `docker-compose.yml` (add a `redis` service)
- Modify: `package.json` (root `db:up` script)
- Modify: `server/package.json` (add `ioredis`)
- Modify: `server/.env.example` (append two variables)
- Create: `server/lib/redis.js`
- Modify: `server/app.js` (`createApp` takes `redis`; `/health` reports it)
- Modify: `server/server.js` (creates the client, passes it on)
- Modify: `server/test/helpers.js` (add `setupTestRedis`, `quietLog`)
- Modify: `server/test/app.test.js` (four `/health` expectations gain `redis: false`)
- Create: `server/test/redis.test.js`

**Interfaces:**
- Produces: `createRedis(url = process.env.REDIS_URL, { log = console } = {}) → Redis | null`; `whenReady(redis) → Promise<void>`; test helpers `setupTestRedis(t) → Promise<Redis>` (database 1, flushed, closed in `t.after`) and `quietLog = { warn() {} }`; `createApp({ ..., redis = null })`; `/health` JSON `{ ok, db, livekit, redis }`.

- [ ] **Step 1: Add Redis to Docker Compose**

In `docker-compose.yml`, add this service under `services:` (beside `db`):

```yaml
  redis:
    image: redis:7-alpine
    # Only keys with a TTL (cache entries, rate buckets) may be evicted under
    # memory pressure; room state (Phase 7b) has no TTL, so it is never evicted.
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "volatile-lru", "--save", "", "--appendonly", "no"]
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 3s
      retries: 20
```

In the root `package.json`, change the `db:up` script to start both:

```json
    "db:up": "docker compose up -d --wait db redis",
```

In `README.md`, under "Run locally", change the comment next to `npm run db:up` (or add one) to say it starts Postgres **and Redis**.

- [ ] **Step 2: Start it and check it answers**

Run: `npm run db:up && docker compose exec redis redis-cli ping`
Expected: both containers healthy, then `PONG`.

- [ ] **Step 3: Install the client and document the variables**

Run: `npm --prefix server install ioredis@^5`
Expected: `server/package.json` lists `"ioredis": "^5.x.x"` under `dependencies`.

Append to `server/.env.example`:

```
# Redis: shared rate limits and the translation cache. Unset = per-server memory.
REDIS_URL=redis://localhost:6379
# Proxy hops in front of this server: 0 locally, 1 behind Railway or Fly.
TRUST_PROXY=0
```

Add the same two lines to your own `server/.env` (never committed).

- [ ] **Step 4: Write the failing tests**

Create `server/test/redis.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createRedis } = require('../lib/redis');
const { listen, fakeAuth, setupTestRedis, quietLog, settle } = require('./helpers');

const fakeDb = { query: async () => ({ rows: [] }) };
// Nothing listens here, so a client pointed at it can never connect.
const DEAD_REDIS = 'redis://127.0.0.1:6390';

test('no REDIS_URL means no Redis client', () => {
  assert.equal(createRedis(''), null);
  assert.equal(createRedis(undefined), null);
});

test('/health reports redis:true when Redis answers', async (t) => {
  const redis = await setupTestRedis(t);
  const { base, close } = await listen(createApp({ db: fakeDb, auth: fakeAuth, redis }));
  t.after(close);
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.redis, true);
});

test('/health reports redis:false when Redis is configured but unreachable', async (t) => {
  const redis = createRedis(DEAD_REDIS, { log: quietLog });
  t.after(() => redis.disconnect());
  const { base, close } = await listen(createApp({ db: fakeDb, auth: fakeAuth, redis }));
  t.after(close);
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.redis, false);
});

test('an outage is logged once however many retries fail, and the recovery once', async (t) => {
  const warnings = [];
  const redis = createRedis(DEAD_REDIS, { log: { warn: (m) => warnings.push(m) } });
  t.after(() => redis.disconnect());
  await settle(700); // the client retries at 200 ms, 400 ms, ... and each attempt fails
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Redis unavailable/);
  redis.emit('ready'); // what the client emits when a retry finally connects
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /Redis reconnected/);
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `cd server && node --test test/redis.test.js`
Expected: FAIL with `Cannot find module '../lib/redis'`.

- [ ] **Step 6: Write `server/lib/redis.js`**

```js
const Redis = require('ioredis');

// The one Redis connection. While Redis is down, commands fail at once (no offline
// queue, one try, a 500 ms timeout) so every caller falls back immediately instead
// of hanging; the client keeps reconnecting in the background, backing off to 5 s.
// ponytail: one log line per outage and one per recovery, never per command. Add a
// metric if you ever need to know how often it happens.
function createRedis(url = process.env.REDIS_URL, { log = console } = {}) {
  if (!url) return null;
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 500,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  let down = false;
  redis.on('error', (err) => {
    if (down) return;
    down = true;
    log.warn(`Redis unavailable (${err.message}). Falling back until it returns.`);
  });
  redis.on('ready', () => {
    if (!down) return;
    down = false;
    log.warn('Redis reconnected.');
  });
  return redis;
}

// Resolves once the connection is usable. With no offline queue a command sent
// before this rejects, so tests (and anything that must not start degraded) wait here.
function whenReady(redis) {
  if (redis.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    redis.once('ready', resolve);
    redis.once('end', () => reject(new Error('Redis connection ended before it was ready')));
  });
}

module.exports = { createRedis, whenReady };
```

- [ ] **Step 7: Add the test helpers**

In `server/test/helpers.js`, add with the other requires:

```js
const { createRedis, whenReady } = require('../lib/redis');
```

Add after `setupTestDb`:

```js
const quietLog = { warn: () => {} };

// A clean Redis for one test: database 1 (never the dev data in 0), emptied first,
// closed when the test ends. Needs `npm run db:up`.
async function setupTestRedis(t) {
  const redis = createRedis(process.env.TEST_REDIS_URL || 'redis://localhost:6379/1', { log: quietLog });
  await whenReady(redis);
  await redis.flushdb();
  t.after(() => redis.quit());
  return redis;
}
```

Add `setupTestRedis` and `quietLog` to `module.exports`.

- [ ] **Step 8: Report Redis on `/health`**

In `server/app.js`, change the signature and the `/health` handler:

```js
function createApp({ db, auth, livekit, redis = null, google = {} }) {
```

```js
  app.get('/health', async (_req, res) => {
    const [dbOk, livekitOk, redisOk] = await Promise.all([
      reachable(db ? () => db.query('SELECT 1') : null),
      reachable(livekit ? () => livekit.ping() : null),
      reachable(redis ? () => redis.ping() : null),
    ]);
    res.json({ ok: true, db: dbOk, livekit: livekitOk, redis: redisOk });
  });
```

In `server/test/app.test.js`, the four `/health` tests use `deepEqual`; add `redis: false` to each expected object:

```js
  assert.deepEqual(await res.json(), { ok: true, db: false, livekit: false, redis: false });
```

(the "LiveKit answers" test expects `{ ok: true, db: false, livekit: true, redis: false }`).

In `server/server.js`, add the require and create the client right after `createLivekit()`:

```js
const { createRedis } = require('./lib/redis');
```

```js
  const redis = createRedis();
  if (!redis) console.warn("WARNING: REDIS_URL is not set — rate limits and the translation cache stay in this server's memory.");
```

and pass it: `const app = createApp({ db, auth: clerkAuth({ db }), livekit, redis });`

- [ ] **Step 9: Run the new tests, then the whole suite**

Run: `cd server && node --test test/redis.test.js`
Expected: 4 pass.

Run: `cd server && npm test`
Expected: everything passes (the same skips as before).

- [ ] **Step 10: Commit**

```bash
git add docker-compose.yml package.json README.md server/package.json server/package-lock.json server/.env.example server/lib/redis.js server/app.js server/server.js server/test/helpers.js server/test/app.test.js server/test/redis.test.js
git commit -m "feat(server): Redis connection, local Redis in Docker, /health reports it"
```

### Task 2: The token-bucket limiter (memory and Redis)

**Files:**
- Create: `server/lib/rateLimit.js`
- Create: `server/test/rateLimit.test.js`
- Modify: `server/lib/captionRules.js` (its `takeToken` now comes from `rateLimit.js`)

**Interfaces:**
- Consumes: `setupTestRedis`, `quietLog` (Task 1).
- Produces:
  - `POLICIES` — `{ ip, api, create, lookup, lkToken, google, googleAll, connect, aiUser, aiRoom }`, each `{ rate, burst }`.
  - `SOCKET_POLICIES` — `{ 'meeting:join-request', 'chat:message', 'convo:caption', 'convo:set-lang', 'screen:request', host }`, each `{ rate, burst }`.
  - `takeToken(bucket, now, rate, burst) → boolean` (mutates `bucket = { tokens, at }`).
  - `createLimiter({ redis = null, now = null, log = console } = {}) → { take(policyName, id) → Promise<{ allowed: boolean, remaining: number, retryAfterMs: number }> }`. `take` never rejects except for an unknown policy name.

- [ ] **Step 1: Write the failing tests**

Create `server/test/rateLimit.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, POLICIES, takeToken } = require('../lib/rateLimit');
const { setupTestRedis, quietLog } = require('./helpers');

// A clock the test moves by hand, so refills are exact.
function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

// Every behaviour runs twice: per-server memory, and real Redis (database 1).
for (const backend of ['memory', 'redis']) {
  const make = async (t, now) =>
    createLimiter({ redis: backend === 'redis' ? await setupTestRedis(t) : null, now, log: quietLog });

  test(`${backend}: a full burst passes, the next call is refused with the wait`, async (t) => {
    const limiter = await make(t, clock());
    const { burst, rate } = POLICIES.create; // 5, then one every 10 s
    for (let i = 0; i < burst; i++) assert.equal((await limiter.take('create', 'u1')).allowed, true, `call ${i + 1}`);
    const refused = await limiter.take('create', 'u1');
    assert.deepEqual(refused, { allowed: false, remaining: 0, retryAfterMs: Math.ceil(1000 / rate) });
  });

  test(`${backend}: tokens come back at the policy's rate`, async (t) => {
    const now = clock();
    const limiter = await make(t, now);
    for (let i = 0; i < POLICIES.create.burst; i++) await limiter.take('create', 'u1');
    now.advance(5_000); // half a token
    assert.equal((await limiter.take('create', 'u1')).allowed, false, 'not yet');
    now.advance(5_000); // a whole token after 10 s
    assert.equal((await limiter.take('create', 'u1')).allowed, true);
  });

  test(`${backend}: each user and each policy has its own bucket`, async (t) => {
    const limiter = await make(t, clock());
    for (let i = 0; i < POLICIES.create.burst; i++) await limiter.take('create', 'u1');
    assert.equal((await limiter.take('create', 'u1')).allowed, false);
    assert.equal((await limiter.take('create', 'u2')).allowed, true, 'another user');
    assert.equal((await limiter.take('lookup', 'u1')).allowed, true, 'another policy');
  });

  test(`${backend}: remaining counts down`, async (t) => {
    const limiter = await make(t, clock());
    assert.equal((await limiter.take('lookup', 'u1')).remaining, POLICIES.lookup.burst - 1);
    assert.equal((await limiter.take('lookup', 'u1')).remaining, POLICIES.lookup.burst - 2);
  });
}

test('an unknown policy name is a programming error', async () => {
  await assert.rejects(createLimiter({ log: quietLog }).take('nope', 'u1'), /Unknown rate-limit policy "nope"/);
});

test('redis: two limiters on two connections share one budget, like two API servers', async (t) => {
  const now = clock();
  const serverA = createLimiter({ redis: await setupTestRedis(t), now, log: quietLog });
  const serverB = createLimiter({ redis: await setupTestRedis(t), now, log: quietLog });
  let allowed = 0;
  for (let i = 0; i < 10; i++) if ((await (i % 2 ? serverB : serverA).take('create', 'u1')).allowed) allowed += 1;
  assert.equal(allowed, POLICIES.create.burst);
});

test('redis: 20 calls at the same moment from two servers spend exactly the burst', async (t) => {
  const now = clock();
  const serverA = createLimiter({ redis: await setupTestRedis(t), now, log: quietLog });
  const serverB = createLimiter({ redis: await setupTestRedis(t), now, log: quietLog });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? serverB : serverA).take('create', 'u1')));
  assert.equal(results.filter((r) => r.allowed).length, POLICIES.create.burst);
});

test('redis: a bucket key expires once it would have refilled anyway', async (t) => {
  const redis = await setupTestRedis(t);
  await createLimiter({ redis, log: quietLog }).take('create', 'u1');
  const ttl = await redis.pttl('zylo:rl:create:u1');
  const { rate, burst } = POLICIES.create;
  assert.ok(ttl > 0 && ttl <= (burst / rate) * 1000 + 1000, `pttl ${ttl}`);
});

test('Redis failing: memory takes over with the same numbers, warns once, and says when Redis is back', async () => {
  const warnings = [];
  let down = true;
  const redis = {
    zyloTakeToken: async () => {
      if (down) throw new Error('Connection is closed.');
      return [1, 29, 0];
    },
  };
  const limiter = createLimiter({ redis, now: clock(), log: { warn: (m) => warnings.push(m) } });
  for (let i = 0; i < POLICIES.create.burst; i++) assert.equal((await limiter.take('create', 'u1')).allowed, true);
  assert.equal((await limiter.take('create', 'u1')).allowed, false, 'memory enforces the same burst');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /per-server memory/);
  down = false;
  assert.deepEqual(await limiter.take('create', 'u1'), { allowed: true, remaining: 29, retryAfterMs: 0 });
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /back on Redis/);
});

test('takeToken: never holds more than the burst, however long it sat idle', () => {
  const bucket = { tokens: 2, at: 0 };
  takeToken(bucket, 10 * 60_000, 1, 3);
  assert.equal(bucket.tokens, 2); // refilled to 3, then spent 1
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && node --test test/rateLimit.test.js`
Expected: FAIL with `Cannot find module '../lib/rateLimit'`.

- [ ] **Step 3: Write `server/lib/rateLimit.js`**

```js
// Zylo's one rate-limiting algorithm, a token bucket: a bucket holds up to `burst`
// tokens, refills at `rate` tokens a second, and every call spends one. Short bursts
// pass; the average can't exceed `rate`.
//
// Limits shared by every API server (per IP, per user, whole deployment) live in
// Redis and are run by one Lua script, so two servers can never both spend the last
// token. If Redis is unreachable they fall back to this server's memory with the same
// numbers: a few minutes of weaker limits beats refusing everyone.

// Shared limits, keyed zylo:rl:<policy>:<id>. rate is tokens per second.
const POLICIES = Object.freeze({
  ip: { rate: 10, burst: 60 }, //         every HTTP request except the webhook, per client IP, before auth
  api: { rate: 5, burst: 30 }, //         every /api call, per user
  create: { rate: 0.1, burst: 5 }, //     POST /api/meetings
  lookup: { rate: 1, burst: 10 }, //      GET /api/meetings/:id
  lkToken: { rate: 0.2, burst: 5 }, //    GET /api/meetings/:id/livekit-token (each call reaches LiveKit)
  google: { rate: 2, burst: 10 }, //      Google upstream calls, per user (cache hits are free)
  googleAll: { rate: 20, burst: 40 }, //  Google upstream calls, whole deployment
  connect: { rate: 1, burst: 10 }, //     Socket.IO connections, per client IP
  aiUser: { rate: 0.1, burst: 3 }, //     Phase 8 ai:message, per user
  aiRoom: { rate: 0.1, burst: 6 }, //     Phase 8 ai:message, per meeting (6 a minute)
});

// Per-socket limits, kept in memory on the socket (room.js): a socket lives on one
// server for its whole life, so these need no Redis round trip, and the per-IP
// connect limit above stops a reconnect from buying a fresh bucket.
const SOCKET_POLICIES = Object.freeze({
  'meeting:join-request': { rate: 1, burst: 5 },
  'chat:message': { rate: 2, burst: 8 },
  'convo:caption': { rate: 8, burst: 12 },
  'convo:set-lang': { rate: 1, burst: 3 },
  'screen:request': { rate: 0.5, burst: 3 },
  host: { rate: 2, burst: 10 }, // every host:* and lobby:* event shares this one
});

// The in-memory bucket. Mutates `bucket` ({ tokens, at }); true if a token was spent.
function takeToken(bucket, now, rate, burst) {
  const elapsed = Math.max(0, now - bucket.at) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * rate);
  bucket.at = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// The same bucket in Redis, as one script so the read and the write can't be split.
// KEYS[1] the bucket. ARGV: rate, burst, and optionally now (ms): tests pass a fake
// clock; production leaves it out and uses Redis's own clock, so API servers whose
// clocks differ slightly still agree. Returns { allowed 0|1, whole tokens left, ms
// until the next token (0 when allowed) }.
const TOKEN_BUCKET_LUA = `
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not now then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local saved = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(saved[1]) or burst
local at = tonumber(saved[2]) or now
tokens = math.min(burst, tokens + math.max(0, now - at) / 1000 * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
local retry = 0
if allowed == 0 then retry = math.ceil((1 - tokens) / rate * 1000) end
return { allowed, math.floor(tokens), retry }
`;

// ponytail: pruning is "past 10,000 buckets, drop the ones idle long enough to be
// full again", which is the same as never having existed. Fine for one server's memory.
const MAX_MEMORY_BUCKETS = 10_000;

function createMemoryLimiter(now) {
  const buckets = new Map();
  return (key, { rate, burst }) => {
    const t = now();
    if (buckets.size >= MAX_MEMORY_BUCKETS) {
      for (const [k, b] of buckets) if (t - b.at >= b.fullAfterMs) buckets.delete(k);
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, at: t, fullAfterMs: (burst / rate) * 1000 };
      buckets.set(key, bucket);
    }
    const allowed = takeToken(bucket, t, rate, burst);
    const retryAfterMs = allowed ? 0 : Math.ceil(((1 - bucket.tokens) / rate) * 1000);
    return { allowed, remaining: Math.floor(bucket.tokens), retryAfterMs };
  };
}

function createLimiter({ redis = null, now = null, log = console } = {}) {
  const memory = createMemoryLimiter(now ?? Date.now);
  if (redis && typeof redis.zyloTakeToken !== 'function') {
    redis.defineCommand('zyloTakeToken', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  }
  let onMemory = false; // true from the first Redis failure until the next success

  async function take(policyName, id) {
    const policy = POLICIES[policyName];
    if (!policy) throw new Error(`Unknown rate-limit policy "${policyName}"`);
    const key = `zylo:rl:${policyName}:${id}`;
    if (redis) {
      try {
        const args = now ? [policy.rate, policy.burst, now()] : [policy.rate, policy.burst];
        const [allowed, remaining, retryAfterMs] = await redis.zyloTakeToken(key, ...args);
        if (onMemory) {
          onMemory = false;
          log.warn('Rate limits: back on Redis.');
        }
        return { allowed: allowed === 1, remaining, retryAfterMs };
      } catch (err) {
        if (!onMemory) {
          onMemory = true;
          log.warn(`Rate limits: Redis unavailable (${err.message}); using per-server memory until it returns.`);
        }
      }
    }
    return memory(key, policy);
  }

  return { take };
}

module.exports = { POLICIES, SOCKET_POLICIES, takeToken, createLimiter };
```

- [ ] **Step 4: Point `captionRules.js` at the one `takeToken`**

In `server/lib/captionRules.js`, delete the `function takeToken(...) { ... }` block and the `ponytail:` comment above it, and add at the top of the file (after the header comment):

```js
const { takeToken } = require('./rateLimit');
```

Change `allowCaption` to pass its numbers explicitly (the shared `takeToken` has no defaults):

```js
const allowCaption = (bucket, now) => takeToken(bucket, now, RATE, BURST);
```

Leave `module.exports` as it is; `google.js` still imports `takeToken` from here until Task 4, and captions move to `SOCKET_POLICIES` in Task 5.

- [ ] **Step 5: Run the tests**

Run: `cd server && node --test test/rateLimit.test.js test/captionRules.test.js test/tts.test.js test/translate.test.js`
Expected: all pass.

- [ ] **Step 6: Mutation checks**

Make each change, run `node --test test/rateLimit.test.js`, confirm at least one test fails, then undo it:
1. In the Lua script, `if tokens >= 1 then` → `if tokens > 1 then` (the redis burst test fails).
2. In `takeToken`, `if (bucket.tokens < 1)` → `if (bucket.tokens <= 1)` (the memory burst test fails).
3. Delete the `PEXPIRE` line (the TTL test fails).
4. In `take`, replace the `catch` body with `throw err;` (the "Redis failing" test fails).

- [ ] **Step 7: Run the whole suite and commit**

Run: `cd server && npm test`
Expected: all pass.

```bash
git add server/lib/rateLimit.js server/test/rateLimit.test.js server/lib/captionRules.js
git commit -m "feat(server): token-bucket limiter in Redis (Lua) with a per-server memory fallback"
```

### Task 3: HTTP limits: per IP, per user, per route

**Files:**
- Create: `server/lib/limitMiddleware.js`
- Create: `server/test/limits.test.js`
- Modify: `server/app.js` (trust proxy, exposed headers, IP and per-user limits, limiter into `meetingsRouter`)
- Modify: `server/lib/meetings.js` (route limits)
- Modify: `server/server.js` (creates the limiter, reads `TRUST_PROXY`)
- Modify: `server/test/helpers.js` (add `unlimitedLimiter`)

**Interfaces:**
- Consumes: `createLimiter`, `POLICIES` (Task 2); `createApp({ redis })` (Task 1).
- Produces: `limitRequests(limiter, policy, keyOf) → Express middleware`; `sendTooMany(res, retryAfterMs)`; `forwardedIp(forwardedFor, remoteAddress, hops) → string`; `createApp({ db, auth, livekit, redis = null, limiter = createLimiter({ redis }), trustProxy = 0, google = {} })`; `meetingsRouter(db, livekit, limiter)`; test helper `unlimitedLimiter`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/limits.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createLimiter, POLICIES } = require('../lib/rateLimit');
const { forwardedIp } = require('../lib/limitMiddleware');
const { listen, fakeAuth } = require('./helpers');

const fakeDb = { query: async () => ({ rows: [] }) };

// A frozen clock: nothing refills during a test, so every burst is exact.
async function start(t, opts = {}) {
  const { base, close } = await listen(
    createApp({ db: fakeDb, auth: fakeAuth, limiter: createLimiter({ now: () => 1000 }), ...opts }),
  );
  t.after(close);
  return base;
}
const get = (base, path, headers = {}) => fetch(`${base}${path}`, { headers });

test('per IP: the burst passes, then a 429 with Retry-After and a reason', async (t) => {
  const base = await start(t);
  for (let i = 0; i < POLICIES.ip.burst; i++) assert.equal((await get(base, '/health')).status, 200, `request ${i + 1}`);
  const res = await get(base, '/health');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '1'); // 10 a second: the next token in 100 ms, rounded up
  assert.deepEqual(await res.json(), { error: 'Too many requests. Try again in 1 s.', retryAfterMs: 100 });
});

test('every limited response says how many calls are left, and the browser may read it', async (t) => {
  const base = await start(t);
  const res = await get(base, '/health', { origin: 'http://localhost:3000' });
  assert.equal(res.headers.get('ratelimit-remaining'), String(POLICIES.ip.burst - 1));
  const exposed = res.headers.get('access-control-expose-headers') ?? '';
  assert.match(exposed, /Retry-After/);
  assert.match(exposed, /RateLimit-Remaining/);
});

test('the LiveKit webhook is never rate limited', async (t) => {
  const livekit = { ping: async () => {}, receiveWebhook: async () => ({ event: 'room_started' }) };
  const base = await start(t, { livekit });
  for (let i = 0; i < POLICIES.ip.burst; i++) await get(base, '/health');
  assert.equal((await get(base, '/health')).status, 429, 'this IP is out of tokens');
  const res = await fetch(`${base}/livekit/webhook`, { method: 'POST', headers: { authorization: 'signed' }, body: '{}' });
  assert.equal(res.status, 200);
});

test('behind one proxy each client has its own IP bucket; without trust, X-Forwarded-For buys nothing', async (t) => {
  const behindProxy = await start(t, { trustProxy: 1 });
  for (let i = 0; i < POLICIES.ip.burst; i++) await get(behindProxy, '/health', { 'x-forwarded-for': '203.0.113.1' });
  assert.equal((await get(behindProxy, '/health', { 'x-forwarded-for': '203.0.113.1' })).status, 429);
  assert.equal((await get(behindProxy, '/health', { 'x-forwarded-for': '203.0.113.2' })).status, 200, 'another client');

  const direct = await start(t, { trustProxy: 0 });
  for (let i = 0; i < POLICIES.ip.burst; i++) await get(direct, '/health', { 'x-forwarded-for': '203.0.113.1' });
  assert.equal((await get(direct, '/health', { 'x-forwarded-for': '203.0.113.9' })).status, 429, 'a forged header is ignored');
});

test('forwardedIp picks the address our own proxies saw, as Express does', () => {
  assert.equal(forwardedIp('1.1.1.1', '10.0.0.1', 0), '10.0.0.1');
  assert.equal(forwardedIp(undefined, '10.0.0.1', 1), '10.0.0.1');
  assert.equal(forwardedIp('6.6.6.6, 1.1.1.1', '10.0.0.1', 1), '1.1.1.1'); // 6.6.6.6 was written by the client
  assert.equal(forwardedIp('6.6.6.6, 1.1.1.1, 10.0.0.2', '10.0.0.1', 2), '1.1.1.1');
  assert.equal(forwardedIp('1.1.1.1', '10.0.0.1', 3), '1.1.1.1'); // fewer entries than hops: the furthest one
});

test('per user: every /api call counts, and each user has their own budget', async (t) => {
  const base = await start(t);
  const dashboard = (user) => get(base, '/api/dashboard', { 'x-test-user': user });
  for (let i = 0; i < POLICIES.api.burst; i++) assert.equal((await dashboard('u1')).status, 200, `call ${i + 1}`);
  assert.equal((await dashboard('u1')).status, 429);
  assert.equal((await dashboard('u2')).status, 200);
});

test('creating meetings: the burst per user, then 429', async (t) => {
  const base = await start(t);
  const create = () =>
    fetch(`${base}/api/meetings`, { method: 'POST', headers: { 'x-test-user': 'u1', 'content-type': 'application/json' }, body: '{}' });
  for (let i = 0; i < POLICIES.create.burst; i++) assert.equal((await create()).status, 201, `meeting ${i + 1}`);
  assert.equal((await create()).status, 429);
});

test('meeting lookups: the burst per user, then 429', async (t) => {
  const base = await start(t);
  const lookup = () => get(base, '/api/meetings/abc-defg-hij', { 'x-test-user': 'u1' });
  for (let i = 0; i < POLICIES.lookup.burst; i++) assert.equal((await lookup()).status, 404, `lookup ${i + 1}`);
  assert.equal((await lookup()).status, 429);
});

test('LiveKit tokens: the burst per user, counted before any seat check', async (t) => {
  const base = await start(t);
  const token = () => get(base, '/api/meetings/abc-defg-hij/livekit-token', { 'x-test-user': 'u1' });
  for (let i = 0; i < POLICIES.lkToken.burst; i++) assert.equal((await token()).status, 503, `request ${i + 1}`); // no LiveKit here
  assert.equal((await token()).status, 429);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && node --test test/limits.test.js`
Expected: FAIL with `Cannot find module '../lib/limitMiddleware'`.

- [ ] **Step 3: Write `server/lib/limitMiddleware.js`**

```js
// The HTTP side of rateLimit.js, plus the client-IP rule sockets share with it.

// A refusal: 429, Retry-After in whole seconds (at least 1), and the same wait in
// milliseconds in the body, so the client can say "try again in 3 s".
function sendTooMany(res, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: `Too many requests. Try again in ${seconds} s.`, retryAfterMs });
}

// Spends one token from `policy` for keyOf(req). Every response it lets through
// says how many calls are left.
function limitRequests(limiter, policy, keyOf) {
  return async (req, res, next) => {
    const { allowed, remaining, retryAfterMs } = await limiter.take(policy, keyOf(req));
    res.set('RateLimit-Remaining', String(remaining));
    if (!allowed) return sendTooMany(res, retryAfterMs);
    next();
  };
}

// The client's address behind our own proxies: the X-Forwarded-For entry `hops`
// from the right, the one Express's req.ip picks for `trust proxy` = hops. Anything
// further left was written by the client and proves nothing.
function forwardedIp(forwardedFor, remoteAddress, hops) {
  if (!hops || !forwardedFor) return remoteAddress;
  const chain = String(forwardedFor).split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length === 0) return remoteAddress;
  return chain[Math.max(0, chain.length - hops)];
}

module.exports = { limitRequests, sendTooMany, forwardedIp };
```

- [ ] **Step 4: Wire the limits into `server/app.js`**

Add the requires:

```js
const { createLimiter } = require('./lib/rateLimit');
const { limitRequests } = require('./lib/limitMiddleware');
```

Replace everything from the `createApp` signature down to (and including) `app.use(express.json({ limit: '32kb' }));` with:

```js
// `google` is only ever set by tests (a fake Google + a fresh cache) and server.js
// (the Redis cache). Without a `limiter`, one is made on `redis` (memory without it).
function createApp({ db, auth, livekit, redis = null, limiter = createLimiter({ redis }), trustProxy = 0, google = {} }) {
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
  if (livekit) app.use(livekitWebhook(livekit));
  app.use(limitRequests(limiter, 'ip', (req) => req.ip));
  app.use(express.json({ limit: '32kb' }));
```

After `app.use('/api', auth);` add:

```js
  // After auth, so the bucket is the user's, whichever IP they come from.
  app.use('/api', limitRequests(limiter, 'api', (req) => req.userId));
```

and change the meetings line to pass the limiter:

```js
  if (db) app.use('/api', meetingsRouter(db, livekit, limiter));
```

- [ ] **Step 5: Route limits in `server/lib/meetings.js`**

Add the require and change the router's signature:

```js
const { limitRequests } = require('./limitMiddleware');
```

```js
function meetingsRouter(db, livekit, limiter) {
  const router = express.Router();
  // Per user, on top of the app-wide 'api' limit: creating can spam, lookups can
  // guess codes, and every token request makes a call to LiveKit.
  const perUser = (policy) => limitRequests(limiter, policy, (req) => req.userId);
```

Insert the middleware as the second argument of three routes (the handler bodies don't change):

```js
  router.post('/meetings', perUser('create'), async (req, res) => {
```

```js
  router.get('/meetings/:id', perUser('lookup'), async (req, res) => {
```

```js
  router.get('/meetings/:id/livekit-token', perUser('lkToken'), async (req, res) => {
```

- [ ] **Step 6: Create the limiter in `server/server.js`**

```js
const { createLimiter } = require('./lib/rateLimit');
```

After the Redis client is created:

```js
  const limiter = createLimiter({ redis });
  const trustProxy = Number(process.env.TRUST_PROXY) || 0;
```

```js
  const app = createApp({ db, auth: clerkAuth({ db }), livekit, redis, limiter, trustProxy });
```

- [ ] **Step 7: A limiter for tests that must never be limited**

In `server/test/helpers.js`, add (and export):

```js
// For suites that test something else and would trip a real limit by volume alone.
const unlimitedLimiter = { take: async () => ({ allowed: true, remaining: 1, retryAfterMs: 0 }) };
```

- [ ] **Step 8: Run the new tests, then the whole suite**

Run: `cd server && node --test test/limits.test.js`
Expected: 9 pass.

Run: `cd server && npm test`
Expected: all pass. If a test in `meetings.test.js` (or any other HTTP suite) now fails with status 429, it makes more calls as one user than a real limit allows (more than 5 creates, 10 lookups or 30 `/api` calls). Pass `limiter: unlimitedLimiter` to that test's `createApp(...)` call; don't raise the real numbers.

- [ ] **Step 9: Mutation checks**

Make each change, run `node --test test/limits.test.js`, see a failure, undo:
1. Remove `exposedHeaders` from the `cors` options (the header test fails).
2. Move `app.use(limitRequests(limiter, 'ip', ...))` above the webhook line (the webhook test fails).
3. Change `app.set('trust proxy', trustProxy)` to `app.set('trust proxy', 0)` (the proxy test fails).
4. Remove `perUser('create')` from the create route (the create test fails).

- [ ] **Step 10: Commit**

```bash
git add server/lib/limitMiddleware.js server/test/limits.test.js server/app.js server/lib/meetings.js server/server.js server/test/helpers.js
git commit -m "feat(server): rate limits per IP, per user and per route, with Retry-After"
```

(Add any test file you gave `unlimitedLimiter` in Step 8.)

### Task 4: The Google proxy on the shared limiter, and its cache in Redis

**Files:**
- Modify: `server/lib/google.js` (drop the in-process buckets; use `limiter`; translate reads bytes from the cache)
- Modify: `server/lib/cache.js` (add `createRedisCache`)
- Modify: `server/app.js` (pass the limiter to `googleRouter`)
- Modify: `server/server.js` (Redis cache when Redis is configured)
- Modify: `server/test/tts.test.js`, `server/test/translate.test.js` (`start()` builds a limiter; one cross-server cache test each)
- Modify: `server/test/cache.test.js` (Redis cache tests)

**Interfaces:**
- Consumes: `createLimiter`, `POLICIES` (Task 2); `sendTooMany` (Task 3); `setupTestRedis` (Task 1).
- Produces: `googleRouter({ fetchUpstream = fetch, cache = createCache(), limiter = createLimiter() })` (the `now` option is gone); `createRedisCache(redis, { ttlSeconds = 86400 } = {}) → { get(key) → Promise<Buffer|null>, set(key, value) → Promise<void> }`; `google.js` still exports `USER_BURST` and `GLOBAL_BURST`, now read from `POLICIES`.

- [ ] **Step 1: Point the existing Google tests at the limiter**

In both `server/test/tts.test.js` and `server/test/translate.test.js`, add the require and replace `start`:

```js
const { createLimiter } = require('../lib/rateLimit');
```

```js
async function start(google, { now } = {}) {
  return listen(
    createApp({ db: fakeDb, auth: fakeAuth, limiter: createLimiter({ now }), google: { fetchUpstream: google.fetchUpstream, cache: createCache() } }),
  );
}
```

The existing calls `start(google, { now: () => 1000 })` keep working: the frozen clock now reaches every limit through the limiter.

- [ ] **Step 2: Add the failing cache tests**

In `server/test/cache.test.js`, import `createRedisCache` alongside `createCache` from `'../lib/cache'`, add `const { setupTestRedis } = require('./helpers');`, and append:

```js
test('redis cache: what one server stores, another reads back as bytes', async (t) => {
  const serverA = createRedisCache(await setupTestRedis(t));
  const serverB = createRedisCache(await setupTestRedis(t));
  const audio = Buffer.from('ID3-fake-mp3');
  await serverA.set('tts\nhi\nनमस्ते', audio);
  assert.deepEqual(await serverB.get('tts\nhi\nनमस्ते'), audio);
  await serverA.set('tr\nen>de\nHello', 'Hallo');
  assert.equal((await serverB.get('tr\nen>de\nHello')).toString(), 'Hallo');
  assert.equal(await serverB.get('tr\nen>de\nnever stored'), null);
});

test('redis cache: entries live for a day, under readable key names', async (t) => {
  const redis = await setupTestRedis(t);
  await createRedisCache(redis).set('tts\nhi\nनमस्ते', Buffer.from('x'));
  const keys = await redis.keys('zylo:cache:*');
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^zylo:cache:tts:[0-9a-f]{40}$/);
  const ttl = await redis.ttl(keys[0]);
  assert.ok(ttl > 86_000 && ttl <= 86_400, `ttl ${ttl}`);
});

test('redis cache: a failing Redis is a miss, never an error', async () => {
  const fail = async () => {
    throw new Error('Connection is closed.');
  };
  const cache = createRedisCache({ getBuffer: fail, set: fail });
  assert.equal(await cache.get('tts\nhi\nx'), null);
  await cache.set('tts\nhi\nx', Buffer.from('x')); // resolves; nothing thrown
});
```

In `server/test/tts.test.js`, add `const { createRedisCache } = require('../lib/cache');` (next to `createCache`), add `setupTestRedis` to the helpers import, and append:

```js
test('with the Redis cache, a clip fetched through one server is a hit on another', async (t) => {
  const redis = await setupTestRedis(t);
  const google = fakeGoogle();
  const app = () => createApp({ db: fakeDb, auth: fakeAuth, google: { fetchUpstream: google.fetchUpstream, cache: createRedisCache(redis) } });
  const serverA = await listen(app());
  const serverB = await listen(app());
  t.after(serverA.close);
  t.after(serverB.close);
  assert.equal((await tts(serverA.base, { lang: 'mr', text: 'नमस्कार' })).headers.get('x-cache'), 'MISS');
  const res = await tts(serverB.base, { lang: 'mr', text: 'नमस्कार' });
  assert.equal(res.headers.get('x-cache'), 'HIT');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), MP3);
  assert.equal(google.calls.length, 1);
});
```

In `server/test/translate.test.js`, make the same two import changes and append:

```js
test('with the Redis cache, a translation made through one server is a hit on another', async (t) => {
  const redis = await setupTestRedis(t);
  const google = fakeGoogle();
  const app = () => createApp({ db: fakeDb, auth: fakeAuth, google: { fetchUpstream: google.fetchUpstream, cache: createRedisCache(redis) } });
  const serverA = await listen(app());
  const serverB = await listen(app());
  t.after(serverA.close);
  t.after(serverB.close);
  await translate(serverA.base, { from: 'en', to: 'de', text: 'Hello, how are you today?' });
  const res = await translate(serverB.base, { from: 'en', to: 'de', text: 'Hello, how are you today?' });
  assert.equal(res.headers.get('x-cache'), 'HIT');
  assert.deepEqual(await res.json(), { text: 'Hallo, wie geht es dir heute?' });
  assert.equal(google.calls.length, 1);
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd server && node --test test/cache.test.js test/tts.test.js test/translate.test.js`
Expected: FAIL: `createRedisCache is not a function`. (The rate-limit tests in the two route files may also fail until Step 5, because `googleRouter` doesn't use the limiter yet.)

- [ ] **Step 4: Add `createRedisCache` to `server/lib/cache.js`**

Add at the top:

```js
const { createHash } = require('node:crypto');
```

Add below `createCache`:

```js
// The same async get/set, kept in Redis: every API server shares one cache, and it
// survives restarts. Keys are zylo:cache:<kind>:<sha1 of the key>, since a key holds
// up to 500 characters of text. Values come back as bytes (a Buffer); callers that
// stored text call toString(). A Redis error is a miss on get and a no-op on set:
// the cache only ever makes things faster, never breaks them.
const DAY_SECONDS = 24 * 60 * 60;

function createRedisCache(redis, { ttlSeconds = DAY_SECONDS } = {}) {
  const redisKey = (key) => `zylo:cache:${key.split('\n', 1)[0]}:${createHash('sha1').update(key).digest('hex')}`;
  return {
    async get(key) {
      try {
        return await redis.getBuffer(redisKey(key));
      } catch {
        return null;
      }
    },
    async set(key, value) {
      try {
        await redis.set(redisKey(key), value, 'EX', ttlSeconds);
      } catch {
        // The next get is a miss; nothing else to do.
      }
    },
  };
}
```

and export it: `module.exports = { createCache, createRedisCache };`

- [ ] **Step 5: Move `google.js` onto the limiter**

Replace the `require('./captionRules')` line and add two requires:

```js
const { isConvoLang, MAX_CAPTION_LENGTH } = require('./captionRules');
const { createLimiter, POLICIES } = require('./rateLimit');
const { sendTooMany } = require('./limitMiddleware');
```

Replace the block of `USER_RATE` / `USER_BURST` / `GLOBAL_RATE` / `GLOBAL_BURST` constants (and the comment above them) with:

```js
// Upstream budgets live in rateLimit.js (POLICIES.google and POLICIES.googleAll). A
// convo needs well under one call a second per person, so a user gets 2/s with a
// burst of 10, and the whole deployment 20/s, so no one user (or a buggy client
// loop) can get our IP rate-limited by Google for everyone.
const USER_BURST = POLICIES.google.burst;
const GLOBAL_BURST = POLICIES.googleAll.burst;
```

Replace the router's signature and the `buckets` / `serverBucket` / `allowUpstream` block (and its `ponytail:` comment) with:

```js
function googleRouter({ fetchUpstream = fetch, cache = createCache(), limiter = createLimiter() } = {}) {
  const router = express.Router();
  // Spent only on upstream calls: a cache hit costs Google nothing. The user's own
  // budget first, so one user over theirs never spends the whole deployment's.
  async function upstreamRefusal(userId) {
    for (const [policy, id] of [['google', userId], ['googleAll', 'all']]) {
      const result = await limiter.take(policy, id);
      if (!result.allowed) return result;
    }
    return null;
  }
```

In the `/tts` route, replace the `allowUpstream` line with:

```js
        const refused = await upstreamRefusal(req.userId);
        if (refused) return sendTooMany(res, refused.retryAfterMs);
```

In the `/translate` route, replace the two lines `let translated = await cache.get(key);` and `const hit = translated !== null;` with:

```js
      // The Redis cache hands back bytes; the in-memory one, the string it was given.
      const cached = await cache.get(key);
      let translated = cached === null ? null : cached.toString();
      const hit = translated !== null;
```

and replace its `allowUpstream` line the same way as in `/tts`.

In `server/app.js`, pass the limiter:

```js
  app.use('/api', googleRouter({ ...google, limiter })); // /api/tts and /api/translate
```

In `server/server.js`, use the Redis cache when Redis is configured:

```js
const { createCache, createRedisCache } = require('./lib/cache');
```

```js
  const app = createApp({
    db, auth: clerkAuth({ db }), livekit, redis, limiter, trustProxy,
    google: { cache: redis ? createRedisCache(redis) : createCache() },
  });
```

- [ ] **Step 6: Run the tests**

Run: `cd server && node --test test/cache.test.js test/tts.test.js test/translate.test.js`
Expected: all pass, including the existing per-user, whole-server and shared-budget tests.

- [ ] **Step 7: Mutation checks**

Make each change, run the three files, see a failure, undo:
1. In `upstreamRefusal`, drop the `['googleAll', 'all']` entry (the "whole server has an upstream cap" test fails).
2. In `createRedisCache.get`, return `null` always (both cross-server tests fail).
3. Remove `'EX', ttlSeconds` from `set` (the TTL test fails).

- [ ] **Step 8: Whole suite and commit**

Run: `cd server && npm test`
Expected: all pass.

```bash
git add server/lib/google.js server/lib/cache.js server/app.js server/server.js server/test/tts.test.js server/test/translate.test.js server/test/cache.test.js
git commit -m "feat(server): Google proxy on the shared limiter; translation cache in Redis"
```

### Task 5: Socket limits: connections per IP, events per socket

**Files:**
- Modify: `server/lib/limitMiddleware.js` (add `limitConnections`)
- Modify: `server/lib/room.js` (per-socket buckets; `rate-limited` event)
- Modify: `server/lib/captionRules.js` (remove `RATE`, `BURST`, `allowCaption`, the `takeToken` import)
- Modify: `server/server.js` (connection limit before auth)
- Modify: `server/test/captionRules.test.js` (its three `allowCaption` tests move to `rateLimit.test.js`)
- Modify: `server/test/rateLimit.test.js` (the caption bucket test)
- Create: `server/test/socketLimits.test.js`

**Interfaces:**
- Consumes: `SOCKET_POLICIES`, `takeToken`, `POLICIES.connect` (Task 2); `forwardedIp` (Task 3).
- Produces: `limitConnections(limiter, hops) → Socket.IO middleware` (refusal: `Error('Too many connections. Try again shortly.')` with `err.data = { retryAfterMs }`); server event `rate-limited` with payload `{ event }` where `event` is `'meeting:join-request' | 'chat:message' | 'screen:request' | 'host'`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/socketLimits.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, POLICIES, SOCKET_POLICIES } = require('../lib/rateLimit');
const { limitConnections } = require('../lib/limitMiddleware');
const { startSocketServer, connectClient, fakeSocketAuth, waitForEvent, roomHarness, collect, settle } = require('./helpers');

test('connections: the burst from one IP connects, the next is refused with the wait', async (t) => {
  const server = await startSocketServer((io) => {
    io.use(limitConnections(createLimiter({ now: () => 1000 }), 0));
    io.use(fakeSocketAuth);
  });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
  });
  for (let i = 0; i < POLICIES.connect.burst; i++) {
    const client = connectClient(server.url, `u${i}`);
    clients.push(client);
    await waitForEvent(client, 'connect');
  }
  const refused = connectClient(server.url, 'one-too-many');
  clients.push(refused);
  const err = await waitForEvent(refused, 'connect_error');
  assert.equal(err.message, 'Too many connections. Try again shortly.');
  assert.equal(err.data.retryAfterMs, 1000); // one connection a second
});

test('chat: a flood delivers the burst and tells the sender about the rest', async (t) => {
  const { join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const delivered = collect(p1, 'chat:message');
  const refused = collect(host, 'rate-limited');
  const { burst } = SOCKET_POLICIES['chat:message'];
  for (let i = 0; i < burst + 4; i++) host.emit('chat:message', { text: `message ${i}` });
  await settle(150);
  assert.equal(delivered.length, burst);
  assert.deepEqual(refused, Array(4).fill({ event: 'chat:message' }));
});

test('host actions share one bucket', async (t) => {
  const { join, livekit } = await roomHarness(t);
  const host = await join('host');
  await join('p1');
  const refused = collect(host, 'rate-limited');
  const { burst } = SOCKET_POLICIES.host;
  for (let i = 0; i < burst + 2; i++) host.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(livekit.callsTo('muteMic').length, burst);
  assert.deepEqual(refused, Array(2).fill({ event: 'host' }));
});

test('join requests: the burst per socket, then rate-limited', async (t) => {
  const { connect, meetingId } = await roomHarness(t);
  const client = connect('host');
  await waitForEvent(client, 'connect');
  const refused = collect(client, 'rate-limited');
  const { burst } = SOCKET_POLICIES['meeting:join-request'];
  for (let i = 0; i < burst + 1; i++) client.emit('meeting:join-request', { meetingId });
  await settle(200);
  assert.deepEqual(refused, [{ event: 'meeting:join-request' }]);
});
```

In `server/test/rateLimit.test.js`, add `SOCKET_POLICIES` to the require and append:

```js
test('captions: a burst of 12 passes, the 13th is dropped, and 250 ms buys back 2', () => {
  const { rate, burst } = SOCKET_POLICIES['convo:caption'];
  const bucket = { tokens: burst, at: 0 };
  for (let i = 0; i < burst; i++) assert.equal(takeToken(bucket, 0, rate, burst), true, `caption ${i + 1}`);
  assert.equal(takeToken(bucket, 0, rate, burst), false);
  assert.equal(takeToken(bucket, 250, rate, burst), true);
  assert.equal(takeToken(bucket, 250, rate, burst), true);
  assert.equal(takeToken(bucket, 250, rate, burst), false);
});
```

In `server/test/captionRules.test.js`, delete the three tests whose names start with `allowCaption:`, and remove `allowCaption` and `BURST` from its `require('../lib/captionRules')` list.

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && node --test test/socketLimits.test.js`
Expected: FAIL: `limitConnections is not a function`, and the chat, host and join tests see every event get through.

- [ ] **Step 3: Add `limitConnections` to `server/lib/limitMiddleware.js`**

```js
// Socket.IO middleware, run before auth so a reconnect storm never reaches token
// verification. socket.io does not retry a connection a middleware refused, so the
// refusal carries retryAfterMs for the client to retry on its own.
function limitConnections(limiter, hops) {
  return async (socket, next) => {
    const ip = forwardedIp(socket.handshake.headers['x-forwarded-for'], socket.handshake.address, hops);
    const { allowed, retryAfterMs } = await limiter.take('connect', ip);
    if (allowed) return next();
    const err = new Error('Too many connections. Try again shortly.');
    err.data = { retryAfterMs };
    next(err);
  };
}
```

Add it to `module.exports`.

- [ ] **Step 4: Per-socket buckets in `server/lib/room.js`**

Change the requires at the top:

```js
const { isConvoLang, validateCaption } = require('./captionRules');
const { SOCKET_POLICIES, takeToken } = require('./rateLimit');
```

Add above `function registerRoomHandlers`:

```js
// Per-socket buckets (SOCKET_POLICIES). A socket lives on one server for its whole
// life, so these need no Redis round trip; captions are the busiest event in Zylo.
// The per-IP connection limit (limitConnections) stops a reconnect from buying a
// fresh bucket.
function allowEvent(socket, name) {
  const { rate, burst } = SOCKET_POLICIES[name];
  const now = Date.now();
  const buckets = (socket.data.buckets ??= {});
  return takeToken((buckets[name] ??= { tokens: burst, at: now }), now, rate, burst);
}
```

Make these edits inside `registerRoomHandlers`:

1. `hostGuard`: first lines of the function body become

```js
  function hostGuard(socket) {
    if (!allowEvent(socket, 'host')) {
      socket.emit('rate-limited', { event: 'host' });
      return null;
    }
```

(the rest of `hostGuard` is unchanged).

2. `meeting:join-request`: first line of the handler body becomes

```js
      if (!allowEvent(socket, 'meeting:join-request')) return socket.emit('rate-limited', { event: 'meeting:join-request' });
```

3. `convo:set-lang`: after `if (!meetingId) return;` add

```js
      if (!allowEvent(socket, 'convo:set-lang')) return;
```

4. `convo:caption`: replace the comment starting "Captions are chatty" and the `allowCaption(...)` line (the `const now = Date.now();` line goes too) with

```js
      // Captions are chatty (interim results, client-throttled to ~4/s); extras past
      // the bucket are dropped silently, since the next interim replaces them anyway.
      if (!allowEvent(socket, 'convo:caption')) return;
```

5. `chat:message`: after `if (!meetingId) return;` add

```js
      if (!allowEvent(socket, 'chat:message')) return socket.emit('rate-limited', { event: 'chat:message' });
```

6. `screen:request`: after `if (!meetingId) return;` add

```js
      if (!allowEvent(socket, 'screen:request')) return socket.emit('rate-limited', { event: 'screen:request' });
```

`screen:stop`, `meeting:leave` and `disconnect` are not limited: they only ever release things.

- [ ] **Step 5: Remove the old caption limit from `server/lib/captionRules.js`**

Delete the `require('./rateLimit')` line, the comment block starting "The first rate limit in Zylo", the `RATE` and `BURST` constants and `allowCaption`. The exports become:

```js
module.exports = {
  CONVO_LANGS,
  isConvoLang,
  MAX_CAPTION_LENGTH,
  MAX_TRANSLATION_LENGTH,
  validateCaption,
};
```

- [ ] **Step 6: Limit connections in `server/server.js`, before auth**

```js
const { limitConnections } = require('./lib/limitMiddleware');
```

```js
  io.use(limitConnections(limiter, trustProxy)); // before auth: a flood never reaches token checks
  io.use(clerkSocketAuth({ db }));
```

- [ ] **Step 7: Run the tests**

Run: `cd server && node --test test/socketLimits.test.js test/rateLimit.test.js test/captionRules.test.js test/captions.test.js`
Expected: all pass (the existing caption flood test in `captions.test.js` still sees 12 through).

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 8: Mutation checks**

Make each change, run `node --test test/socketLimits.test.js`, see a failure, undo:
1. Delete the `allowEvent(socket, 'chat:message')` line (the chat test fails).
2. Delete the rate check at the top of `hostGuard` (the host test fails).
3. In `limitConnections`, call `next()` unconditionally (the connections test fails).

- [ ] **Step 9: Commit**

```bash
git add server/lib/limitMiddleware.js server/lib/room.js server/lib/captionRules.js server/server.js server/test/socketLimits.test.js server/test/rateLimit.test.js server/test/captionRules.test.js
git commit -m "feat(server): socket connection limit per IP and per-socket event limits"
```

### Task 6: The web app explains a refusal and retries a refused connection

**Files:**
- Create: `web/lib/rate-limit.ts`
- Create: `web/lib/rate-limit.test.ts`
- Modify: `web/lib/use-meeting.ts` (a `rate-limited` toast; retry after a refused connection)

**Interfaces:**
- Consumes: the server's `rate-limited` `{ event }` event and `connect_error` `err.data.retryAfterMs` (Task 5).
- Produces: `rateLimitMessage(event: string): string`; `connectRetryDelay(err: unknown): number | null`.

HTTP needs no client change: `useApi` already throws `ApiError` with the body's `error` ("Too many requests. Try again in N s."), and the Translator Convo's Google calls already treat any non-OK answer as "fall back".

- [ ] **Step 1: Write the failing tests**

Create `web/lib/rate-limit.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRetryDelay, rateLimitMessage } from './rate-limit.ts';

test('each refused event gets its own wording', () => {
  assert.match(rateLimitMessage('chat:message'), /messages too fast/);
  assert.match(rateLimitMessage('meeting:join-request'), /join attempts/);
  assert.match(rateLimitMessage('screen:request'), /sharing your screen/);
  assert.match(rateLimitMessage('host'), /host action/);
});

test('an event without its own wording gets the general one', () => {
  assert.match(rateLimitMessage('something-new'), /too fast/);
});

test('a refused connection is retried after the wait the server named, at least a second', () => {
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 3000 } }), 3000);
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 200 } }), 1000);
});

test('other connection errors are left to socket.io', () => {
  assert.equal(connectRetryDelay(new Error('Sign in required.')), null);
  assert.equal(connectRetryDelay({ data: { retryAfterMs: 'soon' } }), null);
  assert.equal(connectRetryDelay(null), null);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd web && node --test lib/rate-limit.test.ts`
Expected: FAIL, cannot find module `./rate-limit.ts`.

- [ ] **Step 3: Write `web/lib/rate-limit.ts`**

```ts
// What to tell someone the server refused for going too fast. The server sends
// 'rate-limited' { event } for these; extra captions are dropped silently instead.
const MESSAGES: Record<string, string> = {
  'chat:message': 'You’re sending messages too fast. Wait a moment, then try again.',
  'meeting:join-request': 'Too many join attempts. Wait a moment, then try again.',
  'screen:request': 'Wait a moment before sharing your screen again.',
  host: 'Slow down: wait a moment before the next host action.',
};

export function rateLimitMessage(event: string): string {
  return MESSAGES[event] ?? 'You’re doing that too fast. Wait a moment, then try again.';
}

// socket.io never retries a connection the server's middleware refused, so when the
// server's connection limit names a wait, the client retries itself after it (at
// least a second). Any other connect_error is null: socket.io handles those.
export function connectRetryDelay(err: unknown): number | null {
  const wait = (err as { data?: { retryAfterMs?: unknown } } | null)?.data?.retryAfterMs;
  return typeof wait === 'number' && Number.isFinite(wait) ? Math.max(1000, wait) : null;
}
```

- [ ] **Step 4: Use it in `web/lib/use-meeting.ts`**

Add the import:

```ts
import { connectRetryDelay, rateLimitMessage } from '@/lib/rate-limit';
```

Inside the join effect, right after `socketRef.current = socket;`, add:

```ts
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
```

Replace the existing `connect_error` line (keep its two-line comment above it) with:

```ts
    socket.on('connect_error', (err) => {
      setState({ status: 'offline' });
      // Refused by the server's connection limit: socket.io won't retry that one.
      const wait = connectRetryDelay(err);
      if (wait !== null) retryTimer = setTimeout(() => socket.connect(), wait);
    });
```

Next to the `screen:denied` listener, add:

```ts
    socket.on('rate-limited', ({ event }: { event: string }) => toast.error(rateLimitMessage(event)));
```

In the effect's cleanup, clear the timer first:

```ts
    return () => {
      clearTimeout(retryTimer);
      socket.disconnect();
      socketRef.current = null;
    };
```

- [ ] **Step 5: Run the web checks**

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: all pass, 0 lint warnings.

- [ ] **Step 6: Commit**

```bash
git add web/lib/rate-limit.ts web/lib/rate-limit.test.ts web/lib/use-meeting.ts
git commit -m "feat(web): explain rate-limit refusals and retry a refused connection"
```

---

### Task 7: Verify 7a end to end

**Files:**
- Modify: whatever the review in Step 4 finds.

- [ ] **Step 1: Every automated check**

Run from the repo root: `npm run db:up`
Run: `cd server && npm test`
Run: `cd web && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass; the build succeeds.

- [ ] **Step 2: See the keys in real Redis**

Start everything (`npm run livekit` in one terminal, `npm run dev` in another), sign in, open the dashboard, create a meeting, and translate one sentence on `/zylo-translator-convo/check`. Then:

Run: `docker compose exec redis redis-cli --scan --pattern 'zylo:*'`
Expected: at least `zylo:rl:ip:...`, `zylo:rl:api:<your user id>`, `zylo:rl:create:<your user id>` and one `zylo:cache:tr:...`.

Run: `for i in $(seq 1 75); do curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/health; done | sort | uniq -c`
Expected: mostly `200` and at least one `429` (60 in the burst, plus the ~10 a second that refill while curl runs).

- [ ] **Step 3: Redis goes away, the app keeps working**

Run: `docker compose stop redis`
Expected in the API server's log: one `Redis unavailable (...)` line and one `Rate limits: Redis unavailable (...); using per-server memory until it returns.` line, not one per request.

Run: `curl -s http://localhost:4000/health`
Expected: `"redis":false`. The dashboard still loads, a meeting can still be created and joined, chat still works, and a translation still arrives (a cache miss).

Run: `docker compose start redis`, then reload the dashboard.
Expected in the log: `Redis reconnected.` and `Rate limits: back on Redis.`; `/health` shows `"redis":true`.

- [ ] **Step 4: Review the whole 7a diff**

Run `/code-review high` on `git diff main...HEAD`. Fix every correctness finding (with a test where the finding is a behaviour), re-run Step 1, and commit the fixes with specific file names.

- [ ] **Step 5: Hand-off**

Report to the user: what was built, the test counts, what Step 3 showed, and anything skipped. Don't push; 7b (`docs/superpowers/plans/2026-09-27-zylo-phase-7b.md`) starts from this branch when the user says so.

