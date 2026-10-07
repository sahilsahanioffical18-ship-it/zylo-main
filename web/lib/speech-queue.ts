// Ordering and pacing for spoken translations in Zylo Translator Convo: the TTS
// queue speaks finished translations in utterance order without stalling forever on
// a slow one. Zero local imports, free of the DOM, so node --test can run it.

export type Pending = { key: string; seq: number; text: string | null; at: number };

/**
 * Picks the next item to speak, in seq order. A head whose translation is still
 * pending (`text === null`) blocks everything after it until it either arrives or
 * has waited past `waitMs`, at which point it's dropped — the caption still shows,
 * it's just not spoken — and the next item gets the same treatment. Never returns
 * a later item while an earlier one is still pending and within its wait window.
 */
export function nextToSpeak(queue: readonly Pending[], now: number, waitMs = 4000): { speak: Pending | null; drop: string[] } {
  const sorted = [...queue].sort((a, b) => a.seq - b.seq);
  const drop: string[] = [];

  for (const item of sorted) {
    if (item.text !== null) return { speak: item, drop };
    if (now - item.at > waitMs) {
      drop.push(item.key);
      continue;
    }
    // Still within the wait window: an earlier item is pending, so nothing later
    // may speak yet, no matter how ready it is.
    return { speak: null, drop };
  }
  return { speak: null, drop };
}

const SENTENCE_ENDERS = '.!?।॥。！？؟\n';
const CLAUSE_BREAKS = ',،、';

function splitAtChars(text: string, boundary: string): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (boundary.includes(ch)) {
      const piece = buf.trim();
      if (piece) pieces.push(piece);
      buf = '';
    }
  }
  const rest = buf.trim();
  if (rest) pieces.push(rest);
  return pieces;
}

// Never splits a surrogate pair: `for...of` walks a string by Unicode code point.
function hardCutChars(word: string, max: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const codePoint of word) {
    if (current && current.length + codePoint.length > max) {
      pieces.push(current);
      current = '';
    }
    current += codePoint;
  }
  if (current) pieces.push(current);
  return pieces;
}

function pack(pieces: string[], max: number, splitOversize: (piece: string) => string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (piece.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitOversize(piece));
      continue;
    }
    const candidate = current ? `${current} ${piece}` : piece;
    if (candidate.length <= max) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Keeps spoken pieces at or under `max` characters — Chrome's speechSynthesis cuts
 * off long utterances. Splits at sentence ends first, then at commas, then at
 * spaces, then hard-cuts a single oversized word at code-point boundaries.
 */
export function splitForSpeech(text: string, max = 180): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const sentences = splitAtChars(trimmed, SENTENCE_ENDERS);
  return pack(sentences, max, (sentence) =>
    pack(splitAtChars(sentence, CLAUSE_BREAKS), max, (clause) =>
      pack(clause.split(/\s+/).filter(Boolean), max, (word) => hardCutChars(word, max)),
    ),
  );
}

/** Speeds up narration once the queue is backing up. */
export function speechRate(backlog: number): number {
  return backlog >= 2 ? 1.15 : 1;
}
