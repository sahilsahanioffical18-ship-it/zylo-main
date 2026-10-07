import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCaption, attachTranslation, latestFor, captionKey, EMPTY_FEED, isSubtitleStale, SUBTITLE_STALE_MS } from './caption-feed.ts';
import type { CaptionEvent, CaptionFeed } from './caption-feed.ts';

test('interim then final replaces the line in place', () => {
  const interim: CaptionEvent = { userId: 'u1', id: 'a', text: 'hel', lang: 'en', final: false, ts: 1 };
  const final: CaptionEvent = { userId: 'u1', id: 'a', text: 'hello', lang: 'en', final: true, ts: 2 };
  const afterInterim = applyCaption(EMPTY_FEED, interim);
  const afterFinal = applyCaption(afterInterim, final);
  assert.equal(afterFinal.lines.length, 1);
  assert.equal(afterFinal.lines[0].key, captionKey('u1', 'a'));
  assert.equal(afterFinal.lines[0].text, 'hello');
  assert.equal(afterFinal.lines[0].final, true);
});

test('a final is never regressed by a late interim for the same key', () => {
  const final: CaptionEvent = { userId: 'u1', id: 'a', text: 'hello', lang: 'en', final: true, ts: 2 };
  const lateInterim: CaptionEvent = { userId: 'u1', id: 'a', text: 'hel', lang: 'en', final: false, ts: 1 };
  const afterFinal = applyCaption(EMPTY_FEED, final);
  const afterLateInterim = applyCaption(afterFinal, lateInterim);
  assert.equal(afterLateInterim, afterFinal);
  assert.equal(afterLateInterim.lines[0].text, 'hello');
  assert.equal(afterLateInterim.lines[0].final, true);
});

test('a new key appends without disturbing existing lines', () => {
  const first: CaptionEvent = { userId: 'u1', id: 'a', text: 'hi', lang: 'en', final: true, ts: 1 };
  const second: CaptionEvent = { userId: 'u2', id: 'b', text: 'hola', lang: 'es', final: true, ts: 2 };
  const feed1 = applyCaption(EMPTY_FEED, first);
  const feed2 = applyCaption(feed1, second);
  assert.equal(feed2.lines.length, 2);
  assert.equal(feed2.lines[0].text, 'hi');
  assert.equal(feed2.lines[1].text, 'hola');
});

test('a text change on the same key clears its old translation', () => {
  const first: CaptionEvent = {
    userId: 'u1', id: 'a', text: 'hel', lang: 'en', final: false, ts: 1,
    translation: { lang: 'ru', text: 'привет-part' },
  };
  const feed1 = applyCaption(EMPTY_FEED, first);
  assert.deepEqual(feed1.lines[0].translations, { ru: 'привет-part' });

  const second: CaptionEvent = { userId: 'u1', id: 'a', text: 'hello', lang: 'en', final: true, ts: 2 };
  const feed2 = applyCaption(feed1, second);
  assert.deepEqual(feed2.lines[0].translations, {});
});

test('a translation attached on the same event as a text change applies to the new text', () => {
  const first: CaptionEvent = { userId: 'u1', id: 'a', text: 'hel', lang: 'en', final: false, ts: 1 };
  const feed1 = applyCaption(EMPTY_FEED, first);
  const second: CaptionEvent = {
    userId: 'u1', id: 'a', text: 'hello', lang: 'en', final: true, ts: 2,
    translation: { lang: 'ru', text: 'привет' },
  };
  const feed2 = applyCaption(feed1, second);
  assert.deepEqual(feed2.lines[0].translations, { ru: 'привет' });
});

test('attachTranslation ignores a stale translation for text the line has moved past', () => {
  const ev1: CaptionEvent = { userId: 'u1', id: 'a', text: 'hel', lang: 'en', final: false, ts: 1 };
  const feed1 = applyCaption(EMPTY_FEED, ev1);
  const key = captionKey('u1', 'a');

  const ev2: CaptionEvent = { userId: 'u1', id: 'a', text: 'hello', lang: 'en', final: false, ts: 2 };
  const feed2 = applyCaption(feed1, ev2);

  const stale = attachTranslation(feed2, key, 'hel', 'ru', 'bad-translation');
  assert.equal(stale, feed2);
  assert.deepEqual(stale.lines[0].translations, {});

  const fresh = attachTranslation(feed2, key, 'hello', 'ru', 'привет');
  assert.deepEqual(fresh.lines[0].translations, { ru: 'привет' });
});

test('applyCaption trims the oldest lines beyond max', () => {
  let feed: CaptionFeed = EMPTY_FEED;
  for (let i = 0; i < 5; i++) {
    feed = applyCaption(feed, { userId: 'u1', id: `id${i}`, text: `line ${i}`, lang: 'en', final: true, ts: i }, 3);
  }
  assert.equal(feed.lines.length, 3);
  assert.deepEqual(feed.lines.map((l) => l.text), ['line 2', 'line 3', 'line 4']);
});

test('applying an identical event again returns the same feed reference', () => {
  const event: CaptionEvent = { userId: 'u1', id: 'a', text: 'hi', lang: 'en', final: false, ts: 1 };
  const feed1 = applyCaption(EMPTY_FEED, event);
  const feed2 = applyCaption(feed1, event);
  assert.equal(feed2, feed1);
});

test('latestFor returns the most recently timestamped line for that user', () => {
  let feed: CaptionFeed = EMPTY_FEED;
  feed = applyCaption(feed, { userId: 'u1', id: 'a', text: 'first', lang: 'en', final: true, ts: 1 });
  feed = applyCaption(feed, { userId: 'u2', id: 'b', text: 'other user', lang: 'es', final: true, ts: 5 });
  feed = applyCaption(feed, { userId: 'u1', id: 'c', text: 'second', lang: 'en', final: true, ts: 3 });

  assert.equal(latestFor(feed, 'u1')?.text, 'second');
  assert.equal(latestFor(feed, 'u2')?.text, 'other user');
  assert.equal(latestFor(feed, 'nobody'), undefined);
});

test('isSubtitleStale is false right at the threshold and true just past it', () => {
  const ts = 1000;
  assert.equal(isSubtitleStale(ts, ts), false); // no age at all
  assert.equal(isSubtitleStale(ts, ts + SUBTITLE_STALE_MS - 1), false);
  assert.equal(isSubtitleStale(ts, ts + SUBTITLE_STALE_MS), false); // boundary: not yet stale
  assert.equal(isSubtitleStale(ts, ts + SUBTITLE_STALE_MS + 1), true);
});
