const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stuckPhrase, goingInCircles, isQuiet, NUDGE_PROMPT, nudgeText } = require('../lib/nudge');

// ── Stuck phrases ────────────────────────────────────────────────────────────

test('stuck phrases match anywhere in a line, in any case, with straight or curly apostrophes', () => {
  for (const line of [
    "I'm stuck",
    'im stuck on the API',
    'Honestly we’re stuck here',
    'were stuck',
    "I don't know",
    'i dont know which one',
    'IDK',
    'no idea, sorry',
    'Not sure about Friday',
    'I’m lost',
    'im lost',
  ]) {
    assert.equal(stuckPhrase(line), true, line);
  }
});

test('whitespace runs and line breaks inside a phrase do not stop it matching', () => {
  for (const line of ["i'm   stuck", "i'm\nstuck", 'no\t idea', '  not   sure  ']) assert.equal(stuckPhrase(line), true, line);
});

test('stuck phrases match whole words only', () => {
  for (const line of ["I'm stuckey", 'I know', 'idkfa', 'no ideas left', 'not surely', 'Tim stuck', '']) {
    assert.equal(stuckPhrase(line), false, line);
  }
});

test('a line of only question marks or only hmm counts; with anything else it does not', () => {
  for (const line of ['??', ' ???? ', 'hm', 'Hmm', 'hmmmm']) assert.equal(stuckPhrase(line), true, line);
  for (const line of ['?', 'what??', 'hmm ok', 'hmm?', 'h']) assert.equal(stuckPhrase(line), false, line);
});

// ── Going in circles ─────────────────────────────────────────────────────────

test('three lines repeating one point go in circles; case and punctuation are ignored', () => {
  assert.equal(goingInCircles(['We ship it Friday, now!', 'we ship it friday then', 'WE SHIP IT FRIDAY LATER?']), true);
  assert.equal(goingInCircles(['we ship it friday now', 'we ship it friday then']), false, 'fewer than 3 lines');
  assert.equal(goingInCircles([]), false);
});

test('every line needs at least 3 words', () => {
  assert.equal(goingInCircles(['ship friday', 'ship friday', 'ship friday']), false);
  assert.equal(goingInCircles(['ship it friday', 'ship it friday', 'ship it friday']), true);
  assert.equal(goingInCircles(['ship friday', 'ship it friday', 'ship it friday']), false, 'one short line is enough');
});

test('an apostrophe is not a word break, so "it’s fine" is two words', () => {
  assert.equal(goingInCircles(['it’s fine', 'it’s fine', 'it’s fine']), false);
  assert.equal(goingInCircles(["it's fine", "it's fine", "it's fine"]), false);
  assert.equal(goingInCircles(["we don't ship", 'we dont ship', 'we don’t ship']), true, "don't and dont are one word");
});

test('words in other scripts are not split at their combining marks', () => {
  assert.equal(goingInCircles(['नमस्ते दोस्त', 'नमस्ते दोस्त', 'नमस्ते दोस्त']), false, 'two words');
  assert.equal(goingInCircles(['नमस्ते मेरे दोस्त', 'नमस्ते मेरे दोस्त', 'नमस्ते मेरे दोस्त']), true, 'three words');
});

test('every pair must share more than 60% of their words', () => {
  // Each pair shares 3 of 5 words: exactly 0.6, not more.
  assert.equal(goingInCircles(['ship it friday now', 'ship it friday then', 'ship it friday later']), false);
  // Each pair shares 4 of 6: 0.67.
  assert.equal(goingInCircles(['we ship it friday now', 'we ship it friday then', 'we ship it friday later']), true);
  // Two lines agree, the third doesn't.
  assert.equal(goingInCircles(['we ship it friday now', 'we ship it friday then', 'what about the budget though']), false);
  // A chain: lines 1-2 share 4 of 6 words and so do lines 2-3, but lines 1 and 3 share only 3 of 7.
  assert.equal(goingInCircles(['ship it friday now please', 'it friday now please today', 'friday now please today then']), false);
});

test('only the last three lines count', () => {
  const circling = ['we ship it friday now', 'we ship it friday then', 'we ship it friday later'];
  assert.equal(goingInCircles(['something else entirely here', ...circling]), true);
  assert.equal(goingInCircles([...circling, 'something else entirely here']), false);
});

// ── The quiet room ───────────────────────────────────────────────────────────

const ON_AT = 1_000_000;
const quietMeta = (fields = {}) => ({ nudgesOnAt: ON_AT, lastVoiceAt: 0, lastChatAt: 0, quietNudged: false, ...fields });

test('quiet after 60 s with no speech or chat; the clock starts when nudges were switched on', () => {
  assert.equal(isQuiet(quietMeta(), ON_AT + 59_999, 2, 2), false);
  assert.equal(isQuiet(quietMeta(), ON_AT + 60_000, 2, 2), true);
  const spoke = quietMeta({ lastVoiceAt: ON_AT + 30_000 });
  assert.equal(isQuiet(spoke, ON_AT + 89_999, 2, 2), false);
  assert.equal(isQuiet(spoke, ON_AT + 90_000, 2, 2), true);
  const typed = quietMeta({ lastChatAt: ON_AT + 45_000 });
  assert.equal(isQuiet(typed, ON_AT + 104_999, 2, 2), false);
  assert.equal(isQuiet(typed, ON_AT + 105_000, 2, 2), true);
});

test('a time that was never set reads 0: only nudgesOnAt set, a minute old, is quiet', () => {
  assert.equal(isQuiet({ nudgesOnAt: ON_AT }, ON_AT + 60_000, 2, 2), true);
  assert.equal(isQuiet({ nudgesOnAt: ON_AT }, ON_AT + 59_999, 2, 2), false);
});

test('quiet needs no quiet nudge yet in this stretch, 2 people seated and 2 lines from people', () => {
  const later = ON_AT + 120_000;
  assert.equal(isQuiet(quietMeta({ quietNudged: true }), later, 2, 2), false);
  assert.equal(isQuiet(quietMeta(), later, 1, 2), false);
  assert.equal(isQuiet(quietMeta(), later, 2, 1), false);
  assert.equal(isQuiet(quietMeta(), later, 5, 9), true);
});

// ── What the AI is told, and what it says ────────────────────────────────────

test('the nudge prompt, verbatim, with each reason clause', () => {
  assert.equal(
    NUDGE_PROMPT('quiet'),
    "You are Zylo AI, a shared assistant inside a live video meeting. Nobody asked you anything: you are speaking up because nobody has spoken or typed for a minute. You only see the chat text below; you cannot hear the call or see video, so never claim to. If a short nudge would help the group move forward, reply with one or two plain, concrete sentences based on the chat — for example a question that unblocks them, a summary of where they are, or the one point they actually disagree on. If speaking up wouldn't help, reply with exactly NO_NUDGE.",
  );
  assert.match(NUDGE_PROMPT('stuck'), /because someone just wrote that they are stuck or unsure\. /);
  assert.match(NUDGE_PROMPT('circles'), /because the last few chat messages repeat the same point\. /);
});

test('NO_NUDGE anywhere, or nothing at all, means silence; anything else is posted trimmed', () => {
  assert.equal(nudgeText('NO_NUDGE'), null);
  assert.equal(nudgeText('Hmm. NO_NUDGE, I think.'), null);
  assert.equal(nudgeText('  \n '), null);
  assert.equal(nudgeText('\n Where did you land on the date? \n'), 'Where did you land on the date?');
});
