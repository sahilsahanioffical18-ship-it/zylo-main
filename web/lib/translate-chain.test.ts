import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utf8Bytes, chunkForMyMemory, parseMyMemory, translateVia, createLru } from './translate-chain.ts';
import type { Engine } from './translate-chain.ts';

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

test('ASCII text under the byte limit comes back as a single chunk', () => {
  const text = 'Hello there, how are you doing today?';
  assert.deepEqual(chunkForMyMemory(text, 450), [text]);
});

test('a 600+ byte Hindi text splits into multiple chunks, each within the byte cap, with no word lost', () => {
  const sentence = 'नमस्ते, आज आप कैसे हैं? मुझे उम्मीद है कि आप ठीक होंगे।';
  const text = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`;
  assert.ok(utf8Bytes(text) > 600, 'fixture should exceed 600 bytes');

  const chunks = chunkForMyMemory(text, 450);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
    assert.ok(utf8Bytes(chunk) <= 450, `chunk exceeds 450 bytes: ${chunk}`);
  }
  assert.deepEqual(words(chunks.join(' ')), words(text));
});

test('a single long word with no spaces is hard-cut into byte-bounded, non-empty pieces that reassemble exactly', () => {
  const word = 'अ'.repeat(1000); // 3 bytes/char in UTF-8 => 3000 bytes total
  const chunks = chunkForMyMemory(word, 450);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
    assert.ok(utf8Bytes(chunk) <= 450);
  }
  assert.equal(chunks.join(''), word);
});

test('a hard cut never splits an emoji surrogate pair across chunks', () => {
  const word = `${'a'.repeat(7)}😀${'b'.repeat(7)}`; // emoji is 4 UTF-8 bytes / 2 UTF-16 units
  const chunks = chunkForMyMemory(word, 10);
  assert.equal(chunks.join(''), word);
  for (const chunk of chunks) {
    assert.ok(utf8Bytes(chunk) <= 10, `chunk exceeds 10 bytes: ${JSON.stringify(chunk)}`);
    // A torn surrogate pair renders as a lone surrogate at a chunk edge.
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF]$/);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]/);
  }
  assert.ok(chunks.some((c) => c.includes('😀')));
});

test('parseMyMemory: quotaFinished true is quota even with a 200 status and real-looking text', () => {
  const json = { responseData: { translatedText: 'hola' }, quotaFinished: true, responseStatus: 200 };
  assert.deepEqual(parseMyMemory(json), { quota: true });
});

test('parseMyMemory: a quota warning inside translatedText is quota, not a translation', () => {
  const json = {
    responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' },
    quotaFinished: false,
    responseStatus: 200,
  };
  assert.deepEqual(parseMyMemory(json), { quota: true });
});

test('parseMyMemory: a quota warning inside responseDetails is quota', () => {
  const json = {
    responseData: { translatedText: 'hola' },
    quotaFinished: false,
    responseStatus: 200,
    responseDetails: 'USED ALL AVAILABLE FREE TRANSLATIONS TODAY',
  };
  assert.deepEqual(parseMyMemory(json), { quota: true });
});

test('parseMyMemory: numeric non-200 status is an error', () => {
  const json = { responseData: { translatedText: 'hola' }, responseStatus: 403, responseDetails: 'PRIVATE ACCESS BLOCKED' };
  const result = parseMyMemory(json);
  assert.ok('error' in result);
});

test('parseMyMemory: string non-200 status is an error', () => {
  const json = { responseData: { translatedText: 'hola' }, responseStatus: '403' };
  const result = parseMyMemory(json);
  assert.ok('error' in result);
});

test('parseMyMemory: string "200" status is treated as success', () => {
  const json = { responseData: { translatedText: 'hola &amp; adios' }, responseStatus: '200' };
  assert.deepEqual(parseMyMemory(json), { text: 'hola & adios' });
});

test('parseMyMemory: missing or empty translated text is an error', () => {
  assert.ok('error' in parseMyMemory({ responseData: {}, responseStatus: 200 }));
  assert.ok('error' in parseMyMemory({ responseData: { translatedText: '   ' }, responseStatus: 200 }));
});

// Real responses, 2026-09-24: MyMemory's top pick for "Hello, how are you today?"
// was a fuzzy crowd-sourced match of a *different* sentence, with spam attached.
test('parseMyMemory: a fuzzy memory match loses to MyMemory’s own machine translation', () => {
  const json = {
    responseData: { translatedText: 'Tony Montana manages to leave Cuba during the Mariel exodus', match: 0.92 },
    responseStatus: 200,
    matches: [
      { segment: 'Hello. How are you today', translation: 'Tony Montana manages to leave Cuba during the Mariel exodus', match: 0.92, 'created-by': 'MateCat' },
      { segment: 'Hello, how are you today?', translation: 'Hallo, wie geht es dir heute?', match: 0.85, 'created-by': 'MT!' },
    ],
  };
  assert.deepEqual(parseMyMemory(json), { text: 'Hallo, wie geht es dir heute?' });
});

test('parseMyMemory: a fuzzy memory match with no machine translation is rejected, not trusted', () => {
  const json = {
    responseData: { translatedText: 'Не переживай моя собака добрая', match: 0.93 },
    responseStatus: 200,
    matches: [{ segment: 'hello anna, how are you today?', translation: 'Не переживай моя собака добрая', match: 0.93, 'created-by': 'Public Web' }],
  };
  assert.ok('error' in parseMyMemory(json));
});

test('parseMyMemory: an exact memory match (match 1) is trusted; an empty machine translation is ignored', () => {
  const json = {
    responseData: { translatedText: 'Bonjour', match: 1 },
    responseStatus: 200,
    matches: [
      { segment: 'Hello', translation: 'Bonjour', match: 1, 'created-by': 'MateCat' },
      { segment: 'Hello', translation: '', match: 0.85, 'created-by': 'MT!' },
    ],
  };
  assert.deepEqual(parseMyMemory(json), { text: 'Bonjour' });
});

test('parseMyMemory: non-object input is an error', () => {
  for (const bad of [null, undefined, 'oops', 42, ['a']]) {
    assert.ok('error' in parseMyMemory(bad));
  }
});

test('parseMyMemory: decodes the basic HTML entities including numeric ones', () => {
  const json = { responseData: { translatedText: '&lt;b&gt;Caf&#233; &amp; Bar&#39;s&lt;/b&gt; &quot;ok&quot;' }, responseStatus: 200 };
  assert.deepEqual(parseMyMemory(json), { text: `<b>Café & Bar's</b> "ok"` });
});

test('translateVia: same language returns the text unchanged without calling any engine', async () => {
  const engine: Engine = async () => {
    throw new Error('should never be called');
  };
  const result = await translateVia([engine], 'hello', 'en', 'en');
  assert.deepEqual(result, { text: 'hello', engine: -1 });
});

test('translateVia: the first engine that returns a non-empty string wins', async () => {
  const first: Engine = async () => 'bonjour';
  const second: Engine = async () => {
    throw new Error('should not be reached');
  };
  const result = await translateVia([first, second], 'hello', 'en', 'fr');
  assert.deepEqual(result, { text: 'bonjour', engine: 0 });
});

test('translateVia: a null result falls through to the next engine', async () => {
  const first: Engine = async () => null;
  const second: Engine = async () => 'bonjour';
  const result = await translateVia([first, second], 'hello', 'en', 'fr');
  assert.deepEqual(result, { text: 'bonjour', engine: 1 });
});

test('translateVia: a thrown error falls through to the next engine', async () => {
  const first: Engine = async () => {
    throw new Error('network down');
  };
  const second: Engine = async () => 'bonjour';
  const result = await translateVia([first, second], 'hello', 'en', 'fr');
  assert.deepEqual(result, { text: 'bonjour', engine: 1 });
});

test('translateVia: failed is returned once every engine fails', async () => {
  const first: Engine = async () => null;
  const second: Engine = async () => {
    throw new Error('boom');
  };
  const result = await translateVia([first, second], 'hello', 'en', 'fr');
  assert.deepEqual(result, { failed: true });
});

test('createLru evicts the least-recently-used entry, and get refreshes recency', () => {
  const lru = createLru<string>(2);
  lru.set('a', '1');
  lru.set('b', '2');
  assert.equal(lru.get('a'), '1'); // 'a' is now more recent than 'b'
  lru.set('c', '3'); // should evict 'b', not 'a'
  assert.equal(lru.size, 2);
  assert.equal(lru.get('b'), undefined);
  assert.equal(lru.get('a'), '1');
  assert.equal(lru.get('c'), '3');
});

test('createLru overwriting an existing key does not grow past max and keeps it fresh', () => {
  const lru = createLru<number>(2);
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('a', 10); // refresh 'a'
  lru.set('c', 3); // should evict 'b'
  assert.equal(lru.size, 2);
  assert.equal(lru.get('b'), undefined);
  assert.equal(lru.get('a'), 10);
  assert.equal(lru.get('c'), 3);
});
