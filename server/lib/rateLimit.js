// Zylo's one rate-limiting algorithm, a token bucket: a bucket holds up to `burst`
// tokens, refills at `rate` tokens a second, and every call spends one. Short bursts
// pass; the average can't exceed `rate`.
//
// Limits shared by every API server (per IP, per user, whole deployment) live in
// Redis and are run by one Lua script, so two servers can never both spend the last
// token. If Redis is unreachable they fall back to this server's memory with the same
// numbers: a few minutes of weaker limits beats refusing everyone.

const { log: defaultLog } = require('./log');

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
  aiUser: { rate: 0.1, burst: 3 }, //     ai:ask, per user
  aiRoom: { rate: 0.1, burst: 6 }, //     ai:ask, per meeting (6 a minute)
  aiNudgeAll: { rate: 1, burst: 5 }, //   AI nudge calls, whole deployment
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
  'voice:activity': { rate: 0.2, burst: 2 }, // background, so over the limit it's dropped silently
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

function createLimiter({ redis = null, now = null, log = defaultLog } = {}) {
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
