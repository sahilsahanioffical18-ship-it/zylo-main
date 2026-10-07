const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, POLICIES, SOCKET_POLICIES, takeToken } = require('../lib/rateLimit');
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

test('captions: a burst of 12 passes, the 13th is dropped, and 250 ms buys back 2', () => {
  const { rate, burst } = SOCKET_POLICIES['convo:caption'];
  const bucket = { tokens: burst, at: 0 };
  for (let i = 0; i < burst; i++) assert.equal(takeToken(bucket, 0, rate, burst), true, `caption ${i + 1}`);
  assert.equal(takeToken(bucket, 0, rate, burst), false);
  assert.equal(takeToken(bucket, 250, rate, burst), true);
  assert.equal(takeToken(bucket, 250, rate, burst), true);
  assert.equal(takeToken(bucket, 250, rate, burst), false);
});
