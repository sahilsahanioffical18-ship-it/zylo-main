const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChatHistory } = require('../lib/chatHistory');
const { setupTestRedis } = require('./helpers');

const CODE = 'abc-defg-hij';
const KEY = `zylo:chat:{${CODE}}`;

test('keeps the last 20 lines, oldest first, answers marked', async (t) => {
  const redis = await setupTestRedis(t);
  const history = createChatHistory(redis);
  for (let i = 1; i <= 25; i++) await history.add(CODE, { name: 'Priya One', text: `line ${i}` });
  await history.add(CODE, { name: 'Zylo AI', text: 'An answer.', ai: true });
  const entries = await history.recent(CODE);
  assert.equal(entries.length, 20);
  assert.deepEqual(entries[0], { name: 'Priya One', text: 'line 7', ai: false });
  assert.deepEqual(entries.at(-2), { name: 'Priya One', text: 'line 25', ai: false });
  assert.deepEqual(entries.at(-1), { name: 'Zylo AI', text: 'An answer.', ai: true });
  assert.equal(await redis.llen(KEY), 20);
});

test('the history expires 6 hours after its last line', async (t) => {
  const redis = await setupTestRedis(t);
  await createChatHistory(redis).add(CODE, { name: 'Hana Host', text: 'hello' });
  const ttl = await redis.ttl(KEY);
  assert.ok(ttl > 6 * 3600 - 5 && ttl <= 6 * 3600, `ttl was ${ttl}`);
});

test('clear deletes one meeting\'s history and no other; an unknown meeting has none', async (t) => {
  const redis = await setupTestRedis(t);
  const history = createChatHistory(redis);
  await history.add(CODE, { name: 'Hana Host', text: 'bye' });
  await history.add('xyz-wxyz-xyz', { name: 'Pablo Two', text: 'still here' });
  await history.clear(CODE);
  assert.deepEqual(await history.recent(CODE), []);
  assert.equal(await redis.exists(KEY), 0);
  assert.deepEqual(await history.recent('xyz-wxyz-xyz'), [{ name: 'Pablo Two', text: 'still here', ai: false }]);
  assert.deepEqual(await history.recent('zzz-zzzz-zzz'), []);
});
