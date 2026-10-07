const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCache, createRedisCache } = require('../lib/cache');
const { setupTestRedis } = require('./helpers');

const buf = (s) => Buffer.from(s);

test('a stored clip comes back; an unknown key is null', async () => {
  const cache = createCache();
  await cache.set('hi\nनमस्ते', buf('a'));
  assert.deepEqual(await cache.get('hi\nनमस्ते'), buf('a'));
  assert.equal(await cache.get('hi\nother'), null);
});

test('past max entries, the least recently used clip is evicted', async () => {
  const cache = createCache({ max: 2 });
  await cache.set('a', buf('a'));
  await cache.set('b', buf('b'));
  await cache.set('c', buf('c'));
  assert.equal(await cache.get('a'), null);
  assert.deepEqual(await cache.get('b'), buf('b'));
  assert.deepEqual(await cache.get('c'), buf('c'));
});

test('a read refreshes recency, so the unread clip is the one evicted', async () => {
  const cache = createCache({ max: 2 });
  await cache.set('a', buf('a'));
  await cache.set('b', buf('b'));
  await cache.get('a');
  await cache.set('c', buf('c'));
  assert.deepEqual(await cache.get('a'), buf('a'));
  assert.equal(await cache.get('b'), null);
});

test('a clip expires after the TTL', async () => {
  let t = 0;
  const cache = createCache({ ttlMs: 1000, now: () => t });
  await cache.set('a', buf('a'));
  t = 999;
  assert.deepEqual(await cache.get('a'), buf('a'));
  t = 1000;
  assert.equal(await cache.get('a'), null);
});

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
