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
