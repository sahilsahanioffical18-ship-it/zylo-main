const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createCache, createRedisCache } = require('../lib/cache');
const { createLimiter } = require('../lib/rateLimit');
const { USER_BURST: BURST, GLOBAL_BURST } = require('../lib/google');
const { listen, fakeAuth, setupTestRedis } = require('./helpers');

const fakeDb = { query: async () => ({ rows: [] }) };
// Google's gtx answer shape: [[[translated, original, ...], ...], ...] — one entry per sentence.
const gtx = (...sentences) =>
  new Response(JSON.stringify([sentences.map((s) => [s, 'orig', null, null, 10]), null, 'en']), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function fakeGoogle(respond = () => gtx('Hallo, wie geht es dir heute?')) {
  const calls = [];
  const fetchUpstream = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return respond();
  };
  return { fetchUpstream, calls };
}

async function start(google, { now } = {}) {
  return listen(
    createApp({ db: fakeDb, auth: fakeAuth, limiter: createLimiter({ now }), google: { fetchUpstream: google.fetchUpstream, cache: createCache() } }),
  );
}

const translate = (base, query, user = 'u1') =>
  fetch(`${base}/api/translate?${new URLSearchParams(query)}`, { headers: user ? { 'x-test-user': user } : {} });

test('translate: 401 without a signed-in user; Google is never called', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    assert.equal((await translate(base, { from: 'en', to: 'de', text: 'Hello' }, null)).status, 401);
    assert.equal(google.calls.length, 0);
  } finally {
    await close();
  }
});

test('translate: 400 for unknown or identical languages, empty text, or text over 500 characters', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    for (const query of [
      { from: 'xx', to: 'de', text: 'Hello' },
      { from: 'en', to: 'xx', text: 'Hello' },
      { to: 'de', text: 'Hello' },
      { from: 'en', to: 'en', text: 'Hello' },
      { from: 'en', to: 'de', text: '  ' },
      { from: 'en', to: 'de', text: 'a'.repeat(501) },
    ]) {
      assert.equal((await translate(base, query)).status, 400, JSON.stringify(query).slice(0, 60));
    }
    assert.equal((await translate(base, { from: 'en', to: 'de', text: 'a'.repeat(500) })).status, 200); // boundary
    assert.equal(google.calls.length, 1);
  } finally {
    await close();
  }
});

test('translate: joins every sentence Google returns, then serves the cached copy', async () => {
  const google = fakeGoogle(() => gtx('Hallo, wie geht es dir heute? ', 'Ich gehe zum Markt.'));
  const { base, close } = await start(google);
  try {
    const first = await translate(base, { from: 'en', to: 'de', text: 'Hello, how are you today? I am going to the market.' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.deepEqual(await first.json(), { text: 'Hallo, wie geht es dir heute? Ich gehe zum Markt.' });

    const second = await translate(base, { from: 'en', to: 'de', text: '  Hello, how are you today?   I am going to the market. ' });
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.deepEqual(await second.json(), { text: 'Hallo, wie geht es dir heute? Ich gehe zum Markt.' });
    assert.equal(google.calls.length, 1);

    const { url, init } = google.calls[0];
    assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
    assert.equal(url.searchParams.get('client'), 'gtx');
    assert.equal(url.searchParams.get('sl'), 'en');
    assert.equal(url.searchParams.get('tl'), 'de');
    assert.equal(url.searchParams.get('dt'), 't');
    const headerNames = Object.keys(init?.headers ?? {}).map((h) => h.toLowerCase());
    assert.ok(!headerNames.includes('referer'), 'no Referer header');
  } finally {
    await close();
  }
});

test('translate: the cache is per direction (en→de is not de→en)', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    await translate(base, { from: 'en', to: 'de', text: 'Hallo' });
    await translate(base, { from: 'de', to: 'en', text: 'Hallo' });
    assert.equal(google.calls.length, 2);
  } finally {
    await close();
  }
});

test('translate: Chinese is zh-CN on both sides', async () => {
  const google = fakeGoogle(() => gtx('你好'));
  const { base, close } = await start(google);
  try {
    await translate(base, { from: 'zh', to: 'hi', text: '你好' });
    await translate(base, { from: 'hi', to: 'zh', text: 'नमस्ते' });
    assert.equal(google.calls[0].url.searchParams.get('sl'), 'zh-CN');
    assert.equal(google.calls[1].url.searchParams.get('tl'), 'zh-CN');
  } finally {
    await close();
  }
});

test('translate: an error status, a non-JSON page, an empty result or a timeout is a 502, never cached', async () => {
  for (const respond of [
    () => new Response('rate limited', { status: 429 }),
    () => new Response('<html>captcha</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => new Response(JSON.stringify([[], null, 'en']), { status: 200, headers: { 'content-type': 'application/json' } }),
    () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    },
  ]) {
    const google = fakeGoogle(respond);
    const { base, close } = await start(google);
    try {
      assert.equal((await translate(base, { from: 'en', to: 'mr', text: 'Hello' })).status, 502);
      assert.equal((await translate(base, { from: 'en', to: 'mr', text: 'Hello' })).status, 502);
      assert.equal(google.calls.length, 2, 'the failure was not cached');
    } finally {
      await close();
    }
  }
});

test('the whole server has an upstream cap too, however many users ask', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google, { now: () => 1000 }); // frozen clock: no refill
  try {
    for (let i = 0; i < GLOBAL_BURST; i++) {
      assert.equal((await translate(base, { from: 'en', to: 'de', text: `hi ${i}` }, `user${i}`)).status, 200);
    }
    assert.equal((await translate(base, { from: 'en', to: 'de', text: 'fresh user' }, 'someone-new')).status, 429);
    assert.equal(google.calls.length, GLOBAL_BURST);
  } finally {
    await close();
  }
});

test('translate and tts share one per-user budget of upstream calls', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google, { now: () => 1000 }); // frozen clock: no refill
  try {
    for (let i = 0; i < BURST; i++) assert.equal((await translate(base, { from: 'en', to: 'de', text: `line ${i}` })).status, 200);
    assert.equal((await translate(base, { from: 'en', to: 'de', text: 'one too many' })).status, 429);
    const voice = await fetch(`${base}/api/tts?${new URLSearchParams({ lang: 'de', text: 'Hallo' })}`, { headers: { 'x-test-user': 'u1' } });
    assert.equal(voice.status, 429, 'the voice route draws on the same budget');
    assert.equal((await translate(base, { from: 'en', to: 'de', text: 'line 0' })).status, 200, 'a cached translation is free');
  } finally {
    await close();
  }
});

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
