process.env.CLERK_TELEMETRY_DISABLED = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { clerkAuth } = require('../lib/auth');
const { listen } = require('./helpers');

const fakeDb = { query: async () => ({ rows: [] }) };

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('GET /health reports db:false and livekit:false when neither is configured', async () => {
  const { base, close } = await listen(createApp({ db: null, auth: (_req, _res, next) => next() }));
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: false, livekit: false, redis: false, ai: false });
  await close();
});

test('GET /health reports livekit:true when LiveKit answers', async () => {
  const { base, close } = await listen(
    createApp({ db: null, auth: (_req, _res, next) => next(), livekit: { ping: async () => {} } }),
  );
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: false, livekit: true, redis: false, ai: false });
  await close();
});

test('GET /health reports ai:true when AI is configured, without calling the provider', async () => {
  let calls = 0;
  const ai = { model: 'test-model', stream: async () => { calls += 1; return 'unused'; } };
  const { base, close } = await listen(createApp({ db: null, auth: (_req, _res, next) => next(), ai }));
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(body.ai, true);
  assert.equal(calls, 0);
  await close();
});

test('GET /health reports livekit:false when LiveKit is configured but unreachable', async () => {
  const { base, close } = await listen(
    createApp({
      db: null,
      auth: (_req, _res, next) => next(),
      livekit: {
        ping: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:7880');
        },
      },
    }),
  );
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: false, livekit: false, redis: false, ai: false });
  await close();
});

test('GET /health reports db:false when the database is configured but failing', async () => {
  const { base, close } = await listen(
    createApp({
      db: {
        query: async () => {
          throw new Error('connection terminated');
        },
      },
      auth: (_req, _res, next) => next(),
    }),
  );
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: false, livekit: false, redis: false, ai: false });
  await close();
});

test('/api returns 503 when the database is not configured', async () => {
  const { base, close } = await listen(createApp({ db: null, auth: (_req, _res, next) => next() }));
  const res = await fetch(`${base}/api/dashboard`);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /DATABASE_URL/);
  await close();
});

test('/api returns 503 when Clerk keys are missing', () =>
  withEnv({ CLERK_SECRET_KEY: undefined, CLERK_PUBLISHABLE_KEY: undefined }, async () => {
    const { base, close } = await listen(createApp({ db: fakeDb, auth: clerkAuth({ db: fakeDb }) }));
    const res = await fetch(`${base}/api/dashboard`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /CLERK/);
    await close();
  }));

test('/api returns 401 without a session token', () =>
  withEnv(
    {
      CLERK_SECRET_KEY: 'sk_test_' + 'x'.repeat(40),
      CLERK_PUBLISHABLE_KEY: 'pk_test_' + Buffer.from('clerk.example.com$').toString('base64'),
    },
    async () => {
      const { base, close } = await listen(createApp({ db: fakeDb, auth: clerkAuth({ db: fakeDb }) }));
      const res = await fetch(`${base}/api/dashboard`);
      assert.equal(res.status, 401);
      await close();
    },
  ));

test('malformed JSON body returns 400, not 500', async () => {
  const { base, close } = await listen(createApp({ db: fakeDb, auth: (_req, _res, next) => next() }));
  const res = await fetch(`${base}/api/meetings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  assert.equal(typeof (await res.json()).error, 'string');
  await close();
});
