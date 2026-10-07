import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextToSpeak, splitForSpeech, speechRate } from './speech-queue.ts';
import type { Pending } from './speech-queue.ts';

function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

test('nextToSpeak speaks a ready head in order', () => {
  const queue: Pending[] = [{ key: 'a', seq: 1, text: 'hi there', at: 0 }];
  const result = nextToSpeak(queue, 100);
  assert.equal(result.speak?.key, 'a');
  assert.deepEqual(result.drop, []);
});

test('nextToSpeak waits for an earlier pending item instead of skipping to a later ready one', () => {
  const queue: Pending[] = [
    { key: 'a', seq: 1, text: null, at: 0 },
    { key: 'b', seq: 2, text: 'ready to go', at: 0 },
  ];
  const result = nextToSpeak(queue, 1000, 4000); // well within the 4s wait
  assert.equal(result.speak, null);
  assert.deepEqual(result.drop, []);
});

test('nextToSpeak drops a head that has waited past waitMs and speaks the next item', () => {
  const queue: Pending[] = [
    { key: 'a', seq: 1, text: null, at: 0 },
    { key: 'b', seq: 2, text: 'ready to go', at: 0 },
  ];
  const result = nextToSpeak(queue, 5000, 4000); // a has waited 5s > 4s
  assert.equal(result.speak?.key, 'b');
  assert.deepEqual(result.drop, ['a']);
});

test('nextToSpeak drops every timed-out head in a row before finding one to speak', () => {
  const queue: Pending[] = [
    { key: 'a', seq: 1, text: null, at: 0 },
    { key: 'b', seq: 2, text: null, at: 0 },
    { key: 'c', seq: 3, text: 'go', at: 0 },
  ];
  const result = nextToSpeak(queue, 5000, 4000);
  assert.equal(result.speak?.key, 'c');
  assert.deepEqual(result.drop, ['a', 'b']);
});

test('nextToSpeak on an empty queue speaks nothing and drops nothing', () => {
  const result = nextToSpeak([], 1000);
  assert.deepEqual(result, { speak: null, drop: [] });
});

test('nextToSpeak sorts out-of-order arrival by seq before deciding', () => {
  const queue: Pending[] = [
    { key: 'b', seq: 2, text: 'second', at: 0 },
    { key: 'a', seq: 1, text: 'first', at: 0 },
  ];
  const result = nextToSpeak(queue, 100);
  assert.equal(result.speak?.key, 'a');
});

test('splitForSpeech: a short Hindi utterance under max comes back as one piece', () => {
  const text = 'नमस्ते, आज आप कैसे हैं?';
  assert.deepEqual(splitForSpeech(text, 180), [text]);
});

test('splitForSpeech: a long Hindi utterance splits into pieces at or under max, losing no words', () => {
  const sentence = 'नमस्ते, आज आप कैसे हैं? मुझे उम्मीद है कि आप ठीक होंगे और सब कुछ अच्छा चल रहा है।';
  const text = `${sentence} ${sentence} ${sentence}`;
  const pieces = splitForSpeech(text, 60);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(piece.length > 0);
    assert.ok(piece.length <= 60, `piece exceeds 60 chars: ${piece}`);
  }
  assert.deepEqual(words(pieces.join(' ')), words(text));
});

test('splitForSpeech: a long Russian utterance splits into pieces at or under max, losing no words', () => {
  const sentence = 'Привет, как у тебя дела сегодня? Я надеюсь, что всё идёт хорошо и ты в порядке.';
  const text = `${sentence} ${sentence} ${sentence}`;
  const pieces = splitForSpeech(text, 60);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(piece.length > 0);
    assert.ok(piece.length <= 60, `piece exceeds 60 chars: ${piece}`);
  }
  assert.deepEqual(words(pieces.join(' ')), words(text));
});

test('splitForSpeech: a single long word with no spaces is hard-cut and reassembles exactly', () => {
  const word = 'a'.repeat(500);
  const pieces = splitForSpeech(word, 180);
  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(piece.length > 0);
    assert.ok(piece.length <= 180);
  }
  assert.equal(pieces.join(''), word);
});

test('splitForSpeech: empty or whitespace-only text produces no pieces', () => {
  assert.deepEqual(splitForSpeech(''), []);
  assert.deepEqual(splitForSpeech('   '), []);
});

test('speechRate speeds up once the backlog reaches 2', () => {
  assert.equal(speechRate(0), 1);
  assert.equal(speechRate(1), 1);
  assert.equal(speechRate(2), 1.15);
  assert.equal(speechRate(5), 1.15);
});
