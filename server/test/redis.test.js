const { test } = require('node:test');
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const { createApp } = require('../app');
const { createRedis, whenReady } = require('../lib/redis');
const { createLimiter } = require('../lib/rateLimit');
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
  // "localhost" (not 127.0.0.1) so Node tries ::1 and 127.0.0.1 and reports an AggregateError, whose message is empty.
  const redis = createRedis('redis://localhost:6390', { log: { warn: (m) => warnings.push(m) } });
  t.after(() => redis.disconnect());
  await settle(700); // the client retries at 200 ms, 400 ms, ... and each attempt fails
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Redis unavailable/);
  assert.doesNotMatch(warnings[0], /\(\)/, 'the warning should name a reason, not an empty ()');
  redis.emit('ready'); // what the client emits when a retry finally connects
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /Redis reconnected/);
});

test('whenReady fails fast, naming the fix, when Redis is not reachable', async (t) => {
  const redis = createRedis(DEAD_REDIS, { log: quietLog });
  t.after(() => redis.disconnect());
  const started = Date.now();
  await assert.rejects(whenReady(redis, { timeoutMs: 300 }), /npm run db:up/);
  assert.ok(Date.now() - started < 1000, 'should give up near timeoutMs, not hang');
});

test('a hung Redis fails fast: after the first timeouts, calls fall back at once', async (t) => {
  const redis = await setupTestRedis(t);
  const admin = new Redis(process.env.TEST_REDIS_URL || 'redis://localhost:6379/1');
  // A paused Redis blocks every command, admin's too, so no UNPAUSE: wait the pause out.
  t.after(async () => {
    await settle(Math.max(0, pauseEndsAt - Date.now()));
    admin.disconnect();
  });
  let pauseEndsAt = 0;
  await admin.client('PAUSE', 3000, 'ALL'); // OK comes back before the pause bites
  pauseEndsAt = Date.now() + 3000;

  const limiter = createLimiter({ redis, log: quietLog });
  const started = Date.now();
  for (let i = 0; i < 5; i++) {
    assert.equal((await limiter.take('ip', 'x')).allowed, true, 'fails open to memory');
  }
  // Five 500 ms command timeouts would be 2500 ms; socketTimeout (1000 ms) cuts the
  // connection so everything after the first two fails instantly.
  assert.ok(Date.now() - started < 1600, `took ${Date.now() - started} ms`);
});
