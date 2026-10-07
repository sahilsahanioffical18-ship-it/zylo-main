// The free-tier translation pipeline for Zylo Translator Convo: chunking text to fit
// MyMemory's byte cap, parsing its response, chaining translation engines (on-device
// first, MyMemory last) and a small result cache. Zero local imports, free of the
// DOM, so node --test can run it with fake engines instead of real network calls.

const SENTENCE_ENDERS = '.!?।॥。！？؟\n';

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

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

// Splits one oversized word into byte-bounded pieces. `for...of` walks a string by
// Unicode code point (not UTF-16 code unit), so a surrogate pair is always kept
// whole in one piece or the other — this loop can never cut one in half.
function hardCutBytes(word: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current = '';
  let bytes = 0;
  for (const codePoint of word) {
    const cpBytes = utf8Bytes(codePoint);
    if (current && bytes + cpBytes > maxBytes) {
      pieces.push(current);
      current = '';
      bytes = 0;
    }
    current += codePoint;
    bytes += cpBytes;
  }
  if (current) pieces.push(current);
  return pieces;
}

// ponytail: a hard-cut word's fragments never re-merge with neighboring words, so a
// pathological single giant word can waste a little of the byte budget around it.
// Upgrade only if MyMemory call volume from this ever actually matters.
function chunkWords(text: string, maxBytes: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    if (utf8Bytes(word) > maxBytes) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...hardCutBytes(word, maxBytes));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (utf8Bytes(candidate) <= maxBytes) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Splits text into chunks that each fit within MyMemory's `q` byte cap (the API
 * caps at 500; 450 leaves headroom for URL-encoding). Splits at sentence ends
 * first, falls back to word boundaries when a sentence is still too big, and
 * hard-cuts a single oversized word at code-point boundaries. Every chunk is
 * non-empty and ≤ maxBytes, and no word is ever dropped.
 */
export function chunkForMyMemory(text: string, maxBytes = 450): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (utf8Bytes(trimmed) <= maxBytes) return [trimmed];

  const sentences = splitAtChars(trimmed, SENTENCE_ENDERS);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (utf8Bytes(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = '';
    }
    if (utf8Bytes(sentence) <= maxBytes) {
      current = sentence;
    } else {
      chunks.push(...chunkWords(sentence, maxBytes));
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export type MyMemoryResult = { text: string } | { quota: true } | { error: string };

const QUOTA_WARNING = /MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS/i;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39);/g, (match, name: string) => NAMED_ENTITIES[name] ?? match)
    .replace(/&#(\d+);/g, (match, digits: string) => String.fromCodePoint(Number(digits)));
}

/**
 * Parses MyMemory's `{responseData: {translatedText}, quotaFinished,
 * responseStatus, responseDetails}` response shape (`responseStatus` may come back
 * as the number 200 or a string like "403"). Quota exhaustion is checked first,
 * before trusting `translatedText` at all: on quota, that field *is* the warning
 * message, not a translation.
 */
export function parseMyMemory(json: unknown): MyMemoryResult {
  if (!json || typeof json !== 'object') return { error: 'invalid response' };
  const obj = json as Record<string, unknown>;
  const responseData = obj.responseData as Record<string, unknown> | undefined;
  const translatedText = typeof responseData?.translatedText === 'string' ? responseData.translatedText : undefined;
  const responseDetails = typeof obj.responseDetails === 'string' ? obj.responseDetails : undefined;

  if (obj.quotaFinished === true || (translatedText && QUOTA_WARNING.test(translatedText)) || (responseDetails && QUOTA_WARNING.test(responseDetails))) {
    return { quota: true };
  }

  const status = obj.responseStatus;
  if (status !== 200 && status !== '200') {
    return { error: responseDetails ?? `responseStatus ${String(status)}` };
  }

  // MyMemory's top pick is often a *fuzzy* crowd-sourced match: a different
  // sentence, sometimes with spam attached (en→de "Hello, how are you today?" came
  // back as a film plot). Its own machine translation ('MT!') is the honest answer;
  // failing that, only an exact match (match 1, or no score at all) is trusted.
  const matches = Array.isArray(obj.matches) ? (obj.matches as Record<string, unknown>[]) : [];
  const machine = matches.find((m) => m?.['created-by'] === 'MT!' && typeof m.translation === 'string' && m.translation.trim());
  if (machine) return { text: decodeEntities(machine.translation as string) };
  if (typeof responseData?.match === 'number' && responseData.match < 1) return { error: 'only a fuzzy memory match' };

  if (!translatedText || !translatedText.trim()) return { error: 'missing translated text' };
  return { text: decodeEntities(translatedText) };
}

export type Engine = (text: string, from: string, to: string) => Promise<string | null>;

/**
 * Runs the translation chain: same language short-circuits without calling
 * anything. Otherwise tries each engine in order (on-device first, MyMemory last —
 * the caller injects them). A null result or a thrown error moves on to the next
 * engine; the first non-empty string wins.
 */
export async function translateVia(
  engines: readonly Engine[],
  text: string,
  from: string,
  to: string,
): Promise<{ text: string; engine: number } | { failed: true }> {
  if (from === to) return { text, engine: -1 };
  for (let i = 0; i < engines.length; i++) {
    try {
      const result = await engines[i](text, from, to);
      if (result) return { text: result, engine: i };
    } catch {
      // try the next engine
    }
  }
  return { failed: true };
}

/** A Map-based LRU: `get` refreshes recency, `set` evicts the oldest entry over `max`. */
export function createLru<V>(max: number): { get(key: string): V | undefined; set(key: string, value: V): void; readonly size: number } {
  const map = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      if (!map.has(key)) return undefined;
      const value = map.get(key) as V;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key: string, value: V): void {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    get size(): number {
      return map.size;
    },
  };
}
