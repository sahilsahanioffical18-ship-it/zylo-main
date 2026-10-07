const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { createCache, createRedisCache } = require('../lib/cache');
const { createLimiter } = require('../lib/rateLimit');
const { USER_BURST: BURST } = require('../lib/google');
const { listen, fakeAuth, setupTestRedis } = require('./helpers');

const fakeDb = { query: async () => ({ rows: [] }) };
const MP3 = Buffer.from('ID3-fake-mp3-bytes');
const audioResponse = () => new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } });

// A stand-in for Google: records every upstream call, answers with `respond`.
function fakeGoogle(respond = audioResponse) {
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

const tts = (base, query, user = 'u1') =>
  fetch(`${base}/api/tts?${new URLSearchParams(query)}`, { headers: user ? { 'x-test-user': user } : {} });

test('401 without a signed-in user; Google is never called', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    const res = await tts(base, { lang: 'mr', text: 'नमस्कार' }, null);
    assert.equal(res.status, 401);
    assert.equal(google.calls.length, 0);
  } finally {
    await close();
  }
});

test('400 for an unknown language, empty text, or text over 200 characters', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    for (const query of [
      { lang: 'xx', text: 'hello' },
      { text: 'hello' },
      { lang: 'mr', text: '' },
      { lang: 'mr', text: '   ' },
      { lang: 'mr', text: 'a'.repeat(201) },
    ]) {
      assert.equal((await tts(base, query)).status, 400, JSON.stringify(query).slice(0, 60));
    }
    assert.equal((await tts(base, { lang: 'mr', text: 'a'.repeat(200) })).status, 200); // boundary: allowed
    assert.equal(google.calls.length, 1);
  } finally {
    await close();
  }
});

test('serves Google audio, then the cached copy: two requests, one upstream call', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    const first = await tts(base, { lang: 'gu', text: 'નમસ્તે, તમે કેમ છો?' });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'audio/mpeg');
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), MP3);

    // Whitespace differences share one cache entry.
    const second = await tts(base, { lang: 'gu', text: '  નમસ્તે,   તમે કેમ છો?  ' });
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), MP3);

    assert.equal(google.calls.length, 1);
    const { url } = google.calls[0];
    assert.equal(url.origin + url.pathname, 'https://translate.google.com/translate_tts');
    assert.equal(url.searchParams.get('tl'), 'gu');
    assert.equal(url.searchParams.get('q'), 'નમસ્તે, તમે કેમ છો?');
    assert.equal(url.searchParams.get('client'), 'tw-ob');
  } finally {
    await close();
  }
});

test('the upstream request carries no Referer (Google answers 404 to one)', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    await tts(base, { lang: 'ml', text: 'ഹലോ' });
    const { init } = google.calls[0];
    const headerNames = Object.keys(init?.headers ?? {}).map((h) => h.toLowerCase());
    assert.ok(!headerNames.includes('referer'), 'no Referer header');
    assert.equal(init?.referrer, undefined);
  } finally {
    await close();
  }
});

test('Chinese is requested from Google as zh-CN', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google);
  try {
    await tts(base, { lang: 'zh', text: '你好' });
    assert.equal(google.calls[0].url.searchParams.get('tl'), 'zh-CN');
  } finally {
    await close();
  }
});

test('an upstream failure is a 502 and is not cached: the next request tries again', async () => {
  let fail = true;
  const google = fakeGoogle(() => (fail ? new Response('nope', { status: 500 }) : audioResponse()));
  const { base, close } = await start(google);
  try {
    assert.equal((await tts(base, { lang: 'ur', text: 'ہیلو' })).status, 502);
    fail = false;
    const retry = await tts(base, { lang: 'ur', text: 'ہیلو' });
    assert.equal(retry.status, 200);
    assert.equal(retry.headers.get('x-cache'), 'MISS');
    assert.equal(google.calls.length, 2);
  } finally {
    await close();
  }
});

test('a non-audio answer (a captcha page) or a thrown fetch (timeout) is a 502', async () => {
  for (const respond of [
    () => new Response('<html>captcha</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    },
  ]) {
    const { base, close } = await start(fakeGoogle(respond));
    try {
      assert.equal((await tts(base, { lang: 'mr', text: 'नमस्कार' })).status, 502);
    } finally {
      await close();
    }
  }
});

test('upstream calls are rate limited per user; cache hits are not', async () => {
  const google = fakeGoogle();
  const { base, close } = await start(google, { now: () => 1000 }); // frozen clock: no refill
  try {
    for (let i = 0; i < BURST; i++) assert.equal((await tts(base, { lang: 'hi', text: `line ${i}` })).status, 200);
    assert.equal((await tts(base, { lang: 'hi', text: 'one too many' })).status, 429);
    assert.equal((await tts(base, { lang: 'hi', text: 'line 0' })).status, 200, 'a cached clip still plays');
    assert.equal((await tts(base, { lang: 'hi', text: 'one too many' }, 'u2')).status, 200, 'another user has their own bucket');
    assert.equal(google.calls.length, BURST + 1);
  } finally {
    await close();
  }
});

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
