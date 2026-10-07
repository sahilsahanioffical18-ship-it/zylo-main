import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promote, seen, videoIdentities, LIVE_VIDEO_LIMIT } from './speaker-order.ts';

test('an empty room gets no video slots', () => {
  assert.deepEqual(videoIdentities([], []), new Set());
});

test('everyone gets video while the room is smaller than the limit', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual(videoIdentities(order, ['a', 'b', 'c']), new Set(['a', 'b', 'c']));
});

test('only the five most recently active people get video', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const result = videoIdentities(order, order);
  assert.equal(result.size, 5);
  assert.deepEqual(result, new Set(order.slice(0, LIVE_VIDEO_LIMIT)));
});

test('re-promoting a current speaker moves them to the front without duplicating', () => {
  const result = promote(['a', 'b', 'c'], ['c']);
  assert.deepEqual(result, ['c', 'a', 'b']);
  assert.equal(result.length, 3);

  // A duplicated identities argument must not inject duplicates into order.
  const deduped = promote(['a', 'b', 'c'], ['c', 'c']);
  assert.deepEqual(deduped, ['c', 'a', 'b']);
  assert.equal(deduped.length, 3);
});

test('promote keeps the relative order of everyone it did not name', () => {
  assert.deepEqual(promote(['a', 'b', 'c', 'd'], ['c']), ['c', 'a', 'b', 'd']);
});

test('promoting several speakers at once keeps the order LiveKit gave them', () => {
  assert.deepEqual(promote(['a', 'b', 'c'], ['c', 'a']), ['c', 'a', 'b']);
});

test('someone leaving frees their slot for the next person in order', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const present = order.filter((id) => id !== 'c');
  const result = videoIdentities(order, present);
  assert.equal(result.size, 5);
  assert.equal(result.has('c'), false);
  assert.equal(result.has('f'), true);
});

test('an identity that is not in the room never consumes a slot', () => {
  const order = ['local', 'a', 'b', 'c', 'd', 'e'];
  const present = ['a', 'b', 'c', 'd', 'e'];
  const result = videoIdentities(order, present);
  assert.equal(result.size, 5);
  assert.equal(result.has('local'), false);
  assert.deepEqual(result, new Set(['a', 'b', 'c', 'd', 'e']));
});

test('seen appends new arrivals at the back and is idempotent', () => {
  assert.deepEqual(seen(['a', 'b'], 'c'), ['a', 'b', 'c']);
  const unchanged = seen(['a', 'b'], 'a');
  assert.deepEqual(unchanged, ['a', 'b']);
  assert.equal(unchanged.length, 2);
});
