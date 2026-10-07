import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addMessage,
  AI_ERROR_TEXT,
  AI_STALL_MS,
  applyAi,
  askAiBlocked,
  failStalled,
  MAX_CHAT_ITEMS,
  newlyDone,
  NUDGE_CAPTION,
  shouldReportSpeech,
  SPEECH_REPORT_MS,
} from './ai-chat.ts';
import type { AiAnswer, ChatItem } from './ai-chat.ts';

const ASKED_BY = { userId: 'p1', name: 'Priya One' };
const start = (id = 'a1') => ({ type: 'start' as const, id, askedBy: ASKED_BY, ts: 1000 });
const chunk = (delta: string, id = 'a1') => ({ type: 'chunk' as const, id, delta });
const done = (text: string, id = 'a1') => ({ type: 'done' as const, id, text });
const failed = (id = 'a1') => ({ type: 'failed' as const, id });
const nudge = (reason: 'quiet' | 'stuck' | 'circles', id = 'n1') =>
  ({ type: 'nudge' as const, id, text: 'Where did you land on the date?', reason, ts: 2000 });
const answerIn = (items: ChatItem[], id = 'a1') => items.find((i): i is AiAnswer => i.kind === 'ai' && i.id === id);

test('start adds a thinking answer after the question; pieces stream into it; done finishes it', () => {
  let items = addMessage([], { userId: 'p1', name: 'Priya One', text: 'When do we ship?', ts: 900, toAi: true });
  items = applyAi(items, start(), 5);
  assert.deepEqual(items[1], { kind: 'ai', id: 'a1', askedBy: ASKED_BY, text: '', status: 'thinking', ts: 1000, heardAt: 5 });
  items = applyAi(items, chunk('Ship '), 6);
  items = applyAi(items, chunk('Friday.'), 7);
  assert.deepEqual([answerIn(items)?.status, answerIn(items)?.text, answerIn(items)?.heardAt], ['streaming', 'Ship Friday.', 7]);
  items = applyAi(items, done('Ship Friday.'), 8);
  assert.equal(answerIn(items)?.status, 'done');
  assert.deepEqual(items[0], { kind: 'person', userId: 'p1', name: 'Priya One', text: 'When do we ship?', ts: 900, toAi: true });
});

test("done's full text replaces whatever pieces arrived", () => {
  let items = applyAi([], start(), 0);
  items = applyAi(items, chunk('Ship '), 1); // "on Friday." never arrived
  items = applyAi(items, done('Ship on Friday.'), 2);
  assert.equal(answerIn(items)?.text, 'Ship on Friday.');
  let quiet = applyAi([], start('a2'), 0);
  quiet = applyAi(quiet, done('All of it.', 'a2'), 1); // straight from thinking
  assert.equal(answerIn(quiet, 'a2')?.text, 'All of it.');
});

test('repeats and late events change nothing, and hand back the same list', () => {
  const started = applyAi([], start(), 0);
  assert.equal(applyAi(started, start(), 1), started);
  const finished = applyAi(started, done('Final.'), 2);
  assert.equal(applyAi(finished, chunk(' extra'), 3), finished);
  assert.equal(applyAi(finished, done('Final.'), 4), finished);
  assert.equal(applyAi(finished, failed(), 5), finished);
  const gaveUp = applyAi(started, failed(), 2);
  assert.equal(answerIn(gaveUp)?.status, 'failed');
  assert.equal(applyAi(gaveUp, chunk('late'), 3), gaveUp);
  assert.equal(applyAi(gaveUp, failed(), 3), gaveUp);
});

test('events for an answer that never started here are ignored', () => {
  const items = addMessage([], { userId: 'p1', name: 'Priya One', text: 'hi', ts: 1 });
  for (const event of [chunk('x', 'zz'), done('x', 'zz'), failed('zz')]) assert.equal(applyAi(items, event, 2), items);
});

test('two answers at once stay independent', () => {
  let items = applyAi(applyAi([], start('a1'), 0), start('a2'), 0);
  items = applyAi(items, chunk('one', 'a1'), 1);
  items = applyAi(items, chunk('two', 'a2'), 1);
  items = applyAi(items, failed('a1'), 2);
  assert.equal(answerIn(items, 'a1')?.status, 'failed');
  assert.deepEqual([answerIn(items, 'a2')?.status, answerIn(items, 'a2')?.text], ['streaming', 'two']);
});

test('the stall rule: 45 s without a piece fails a thinking or streaming answer, nothing else', () => {
  assert.equal(AI_STALL_MS, 45_000);
  let items = applyAi([], start('a1'), 0); // thinking since 0
  items = applyAi(items, start('a2'), 0);
  items = applyAi(items, chunk('still going', 'a2'), 10_000); // last heard at 10 s
  items = applyAi(items, start('a3'), 0);
  items = applyAi(items, done('Finished.', 'a3'), 1);
  assert.equal(failStalled(items, AI_STALL_MS - 1), items);
  const later = failStalled(items, AI_STALL_MS);
  assert.deepEqual(['a1', 'a2', 'a3'].map((id) => answerIn(later, id)?.status), ['failed', 'streaming', 'done']);
  assert.equal(answerIn(failStalled(later, 10_000 + AI_STALL_MS), 'a2')?.status, 'failed');
});

test('a late done still lands after the stall rule gave up', () => {
  const stalled = failStalled(applyAi([], start(), 0), AI_STALL_MS);
  assert.equal(answerIn(stalled)?.status, 'failed');
  const landed = applyAi(stalled, done('Here after all.'), AI_STALL_MS + 1);
  assert.deepEqual([answerIn(landed)?.status, answerIn(landed)?.text], ['done', 'Here after all.']);
});

test('the list keeps the last 200 items, answers included', () => {
  let items: ChatItem[] = [];
  for (let i = 0; i < MAX_CHAT_ITEMS; i++) items = addMessage(items, { userId: 'p1', name: 'P', text: `m${i}`, ts: i });
  items = applyAi(items, start(), 0);
  assert.equal(items.length, MAX_CHAT_ITEMS);
  assert.equal(items.at(-1)?.kind, 'ai');
  assert.equal(items[0].text, 'm1');
});

test('each finished answer is handed out once, for one pop-up each', () => {
  const seen = new Set<string>();
  let items = applyAi([], start('a1'), 0);
  assert.deepEqual(newlyDone(items, seen), []);
  items = applyAi(items, done('First.', 'a1'), 1);
  assert.deepEqual(newlyDone(items, seen).map((a) => a.id), ['a1']);
  assert.deepEqual(newlyDone(items, seen), []);
  items = applyAi(applyAi(items, start('a2'), 2), done('Second.', 'a2'), 3);
  assert.deepEqual(newlyDone(items, seen).map((a) => a.text), ['Second.']);
});

test('why Ask AI is off', () => {
  assert.equal(askAiBlocked(false, true), 'AI isn’t set up on this server.');
  assert.equal(askAiBlocked(false, false), AI_ERROR_TEXT.not_configured);
  assert.equal(askAiBlocked(true, false), 'The host turned AI off.');
  assert.equal(askAiBlocked(true, true), null);
});

test('a nudge arrives as a finished Zylo AI item carrying its reason; a repeated id changes nothing', () => {
  const before = addMessage([], { userId: 'p1', name: 'Priya One', text: 'idk', ts: 1500 });
  const items = applyAi(before, nudge('stuck'), 7);
  assert.deepEqual(items[1], {
    kind: 'ai',
    id: 'n1',
    askedBy: null,
    text: 'Where did you land on the date?',
    status: 'done',
    ts: 2000,
    heardAt: 7,
    nudge: 'stuck',
  });
  assert.equal(applyAi(items, nudge('stuck'), 8), items);
  assert.equal(failStalled(items, AI_STALL_MS * 2), items, 'a nudge never stalls');
});

test('nudges count toward the 200-item cap', () => {
  let items: ChatItem[] = [];
  for (let i = 0; i < MAX_CHAT_ITEMS; i++) items = addMessage(items, { userId: 'p1', name: 'P', text: `m${i}`, ts: i });
  items = applyAi(items, nudge('quiet'), 0);
  assert.equal(items.length, MAX_CHAT_ITEMS);
  assert.equal(answerIn(items, 'n1')?.nudge, 'quiet');
  assert.equal(items[0].text, 'm1');
});

test('a nudge pops up once, like a finished answer', () => {
  const seen = new Set<string>();
  const items = applyAi([], nudge('circles'), 0);
  assert.deepEqual(newlyDone(items, seen).map((a) => a.id), ['n1']);
  assert.deepEqual(newlyDone(items, seen), []);
});

test('nudge captions say why the AI spoke up', () => {
  assert.deepEqual(NUDGE_CAPTION, {
    quiet: 'AI noticed: quiet for a while',
    stuck: 'AI noticed: someone said they’re stuck',
    circles: 'AI noticed: the chat is going in circles',
  });
});

test('speech is reported at most once every 10 s', () => {
  assert.equal(SPEECH_REPORT_MS, 10_000);
  assert.equal(shouldReportSpeech(0, Date.now()), true, 'the first time');
  assert.equal(shouldReportSpeech(50_000, 59_999), false);
  assert.equal(shouldReportSpeech(50_000, 60_000), true);
});
