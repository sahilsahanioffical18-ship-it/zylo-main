// Zylo AI nudges: when the AI may speak up unasked, and what it is told then. Pure
// rules with no I/O, so they're tested alone; room.js reads the signals, claims the
// nudge, asks the AI and posts what it says.

const QUIET_MS = 60_000;
const MIN_SEATED = 2;
const MIN_HUMAN_LINES = 2;
const CIRCLE_LINES = 3;
const CIRCLE_MIN_WORDS = 3;
const CIRCLE_OVERLAP = 0.6;

// Lower case, curly apostrophes straightened, whitespace runs collapsed to one space.
const normal = (text) =>
  text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

// Whole words, so "stuckey" or "I know" never match.
// ponytail: English phrases only. Extend the list, or ask a model, to cover other languages.
const STUCK_PHRASE = /\b(?:i'?m stuck|we'?re stuck|i don'?t know|idk|no idea|not sure|i'?m lost)\b/;
// A whole line of "??" (or more), or of "hm", "hmm", "hmmm"...
const STUCK_LINE = /^(?:\?{2,}|hm+)$/;

// Someone just wrote that they are stuck or unsure.
function stuckPhrase(text) {
  const line = normal(text);
  return STUCK_PHRASE.test(line) || STUCK_LINE.test(line);
}

// Lower-cased words, punctuation stripped. An apostrophe is dropped, not a word break
// ("it's" is one word, "dont" and "don't" the same), and combining marks stay, so
// accented or Devanagari words are not cut into pieces.
const wordsOf = (text) =>
  normal(text)
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{M}\p{N} ]/gu, ' ')
    .split(' ')
    .filter(Boolean);

// Jaccard: the words two lines share, over all the words either uses.
// ponytail: counts repeated words, not paraphrase ("ship Friday" vs "release on the 5th" differ).
// Embeddings would be the upgrade if that matters.
function overlap(a, b) {
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared);
}

// lines: what people wrote, oldest first. The last 3 repeat one point: each has at least
// 3 words, and every pair shares more than 60% of their words.
function goingInCircles(lines) {
  if (lines.length < CIRCLE_LINES) return false;
  const words = lines.slice(-CIRCLE_LINES).map(wordsOf);
  if (words.some((w) => w.length < CIRCLE_MIN_WORDS)) return false;
  const sets = words.map((w) => new Set(w));
  return sets.every((a, i) => sets.slice(i + 1).every((b) => overlap(a, b) > CIRCLE_OVERLAP));
}

// The cheap half of the quiet rule, the meta alone: no quiet nudge yet in this stretch,
// and a minute since the last speech, chat line or nudges being switched on (missing
// times read 0). room.js asks this before it reads the seats and the history.
function quietLongEnough(meta, now) {
  const last = Math.max(meta.lastVoiceAt || 0, meta.lastChatAt || 0, meta.nudgesOnAt || 0);
  return !meta.quietNudged && now - last >= QUIET_MS;
}

// The quiet-room trigger: quiet long enough, at least 2 people seated, and at least 2
// lines from people for the AI to read (it only sees the chat).
function isQuiet(meta, now, seated, humanLines) {
  return quietLongEnough(meta, now) && seated >= MIN_SEATED && humanLines >= MIN_HUMAN_LINES;
}

const REASONS = {
  quiet: 'nobody has spoken or typed for a minute',
  stuck: 'someone just wrote that they are stuck or unsure',
  circles: 'the last few chat messages repeat the same point',
};

// The system prompt for a nudge (spec §5, verbatim apart from the reason clause).
const NUDGE_PROMPT = (reason) =>
  [
    'You are Zylo AI, a shared assistant inside a live video meeting.',
    `Nobody asked you anything: you are speaking up because ${REASONS[reason]}.`,
    'You only see the chat text below; you cannot hear the call or see video, so never claim to.',
    'If a short nudge would help the group move forward, reply with one or two plain, concrete sentences based on the chat — for example a question that unblocks them, a summary of where they are, or the one point they actually disagree on.',
    "If speaking up wouldn't help, reply with exactly NO_NUDGE.",
  ].join(' ');

// What to post, or null: the AI chose silence (NO_NUDGE anywhere) or said nothing.
// Never a canned line in its place.
function nudgeText(answer) {
  const text = answer.trim();
  return !text || text.includes('NO_NUDGE') ? null : text;
}

module.exports = { stuckPhrase, goingInCircles, quietLongEnough, isQuiet, NUDGE_PROMPT, nudgeText };
