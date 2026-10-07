import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRecognitionEnd, normalizeForEcho, isEcho, joinTranscripts } from './speech-policy.ts';

test('a normal end or no-speech restarts immediately with no notice', () => {
  for (const reason of ['end', 'no-speech']) {
    assert.deepEqual(onRecognitionEnd(reason, 0), { restart: true, delayMs: 0, notice: null });
    assert.deepEqual(onRecognitionEnd(reason, 3), { restart: true, delayMs: 0, notice: null }, `${reason} should ignore attempt`);
  }
});

// Chrome runs one recognition session at a time: another tab or window starting
// one aborts ours. Restarting instantly made two windows abort each other forever.
test('aborted backs off (another tab has the recognizer), quiet on the first attempt', () => {
  assert.deepEqual(onRecognitionEnd('aborted', 0), { restart: true, delayMs: 1000, notice: null });
  const second = onRecognitionEnd('aborted', 1);
  assert.equal(second.restart, true);
  assert.equal(second.delayMs, 2000);
  assert.match(second.notice ?? '', /another tab or window/i);
  assert.equal(onRecognitionEnd('aborted', 10).delayMs, 10000);
});

test('network restarts with exponential backoff capped at 10s, and a reconnecting notice', () => {
  const zero = onRecognitionEnd('network', 0);
  assert.equal(zero.restart, true);
  assert.equal(zero.delayMs, 1000);
  assert.equal(zero.notice, 'Captions paused, reconnecting…');

  assert.equal(onRecognitionEnd('network', 1).delayMs, 2000);
  assert.equal(onRecognitionEnd('network', 2).delayMs, 4000);
  assert.equal(onRecognitionEnd('network', 3).delayMs, 8000);
  assert.equal(onRecognitionEnd('network', 4).delayMs, 10000); // would be 16000 uncapped
  assert.equal(onRecognitionEnd('network', 10).delayMs, 10000);
});

test('not-allowed and service-not-allowed stop with the mic-blocked notice', () => {
  for (const reason of ['not-allowed', 'service-not-allowed']) {
    const decision = onRecognitionEnd(reason, 0);
    assert.equal(decision.restart, false);
    assert.equal(decision.delayMs, 0);
    assert.match(decision.notice ?? '', /Microphone access for captions is blocked/);
  }
});

test('language-not-supported stops with a language-specific notice', () => {
  const decision = onRecognitionEnd('language-not-supported', 0);
  assert.equal(decision.restart, false);
  assert.match(decision.notice ?? '', /can’t caption this language/);
});

test('audio-capture stops with a no-microphone notice', () => {
  const decision = onRecognitionEnd('audio-capture', 0);
  assert.equal(decision.restart, false);
  assert.match(decision.notice ?? '', /No microphone found/);
});

test('an unknown reason behaves like network but is quiet on the first attempt', () => {
  const first = onRecognitionEnd('some-weird-error', 0);
  assert.equal(first.restart, true);
  assert.equal(first.delayMs, 1000);
  assert.equal(first.notice, null);

  const second = onRecognitionEnd('some-weird-error', 1);
  assert.equal(second.restart, true);
  assert.equal(second.delayMs, 2000);
  assert.equal(second.notice, 'Captions paused, reconnecting…');
});

test('normalizeForEcho lowercases, strips punctuation, collapses whitespace, and trims', () => {
  assert.equal(normalizeForEcho('  Hello,   World!!  '), 'hello world');
  assert.equal(normalizeForEcho('Привет... мир?'), 'привет мир');
  assert.equal(normalizeForEcho(''), '');
});

test('isEcho: an exact recent match is an echo', () => {
  const now = 5000;
  const recent = [{ text: 'Hello there my friend', at: 4000 }];
  assert.equal(isEcho('Hello there my friend', recent, now), true);
});

test('isEcho: recognition hearing only part of what was spoken (contained) is an echo', () => {
  const now = 5000;
  const recent = [{ text: 'I am going to the market today', at: 4000 }];
  assert.equal(isEcho('going to the market', recent, now), true);
});

test('isEcho: a reply that merely contains what was spoken is NOT an echo', () => {
  // Hearing "आप कैसे हैं" and answering "मैं ठीक हूं, आप कैसे हैं" is a normal reply;
  // dropping it lost real speech.
  const now = 5000;
  assert.equal(isEcho('मैं ठीक हूं, आप कैसे हैं', [{ text: 'आप कैसे हैं', at: 4000 }], now), false);
  assert.equal(isEcho('I am going to the market today for vegetables', [{ text: 'market today', at: 4000 }], now), false);
});

test('isEcho: a superset that is mostly what was spoken (echo plus a stray word) is an echo', () => {
  const now = 5000;
  const recent = [{ text: 'I am going to the market today', at: 4000 }];
  assert.equal(isEcho('I am going to the market today okay', recent, now), true);
});

test('isEcho: a match outside the time window is not an echo', () => {
  const now = 10000;
  const recent = [{ text: 'Hello there my friend', at: 1000 }]; // 9s ago, default window 8s
  assert.equal(isEcho('Hello there my friend', recent, now), false);
});

test('isEcho: short replies are exempt even on an exact match', () => {
  const now = 1000;
  const recent = [{ text: 'okay', at: 900 }];
  assert.equal(isEcho('okay', recent, now), false);
  assert.equal(isEcho('да', recent, now), false);
});

test('isEcho: empty text is never an echo', () => {
  const recent = [{ text: 'Hello there my friend', at: 900 }];
  assert.equal(isEcho('', recent, 1000), false);
  assert.equal(isEcho('   ', recent, 1000), false);
});

test('isEcho: punctuation and case differences still match', () => {
  const now = 2000;
  const recent = [{ text: 'Hello, World! How are you?', at: 1000 }];
  assert.equal(isEcho('hello world how are you', recent, now), true);
});

test('joinTranscripts puts exactly one space between chunks, whatever Chrome sends', () => {
  // Real Chrome 153 hi-IN: the second result arrives with NO leading space.
  assert.equal(joinTranscripts(['नमस्ते', 'आज आप']), 'नमस्ते आज आप');
  // en-US results usually carry a leading space.
  assert.equal(joinTranscripts(['hello', ' how are', '  you ']), 'hello how are you');
  assert.equal(joinTranscripts(['', '  ']), '');
});
