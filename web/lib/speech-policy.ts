// End-of-recognition policy and echo detection for Zylo Translator Convo's speech
// captions. Zero local imports, free of the DOM, so node --test can run it directly.

export type EndDecision = { restart: boolean; delayMs: number; notice: string | null };

const RECONNECTING_NOTICE = 'Captions paused, reconnecting…';
const MIC_BLOCKED_NOTICE = 'Microphone access for captions is blocked. Allow it in your browser, or type instead.';
const LANGUAGE_UNSUPPORTED_NOTICE = 'This browser can’t caption this language. Type instead, or try Chrome.';
const NO_MIC_NOTICE = 'No microphone found for captions.';
const RECOGNIZER_BUSY_NOTICE = 'Another tab or window is using speech recognition. Only one can listen at a time.';

function backoffMs(attempt: number): number {
  return Math.min(10000, 1000 * 2 ** attempt);
}

/**
 * Decides whether SpeechRecognition should restart after ending, and what (if
 * anything) to tell the user. `reason` is 'end' for a normal onend, otherwise the
 * SpeechRecognitionErrorEvent.error string.
 */
export function onRecognitionEnd(reason: string, attempt: number): EndDecision {
  switch (reason) {
    case 'end':
    case 'no-speech':
      return { restart: true, delayMs: 0, notice: null };
    case 'aborted':
      // Never our own abort (use-speech-captions nulls its handlers first): another
      // tab or window took Chrome's one recognizer. Back off instead of fighting it.
      return { restart: true, delayMs: backoffMs(attempt), notice: attempt === 0 ? null : RECOGNIZER_BUSY_NOTICE };
    case 'network':
      return { restart: true, delayMs: backoffMs(attempt), notice: RECONNECTING_NOTICE };
    case 'not-allowed':
    case 'service-not-allowed':
      return { restart: false, delayMs: 0, notice: MIC_BLOCKED_NOTICE };
    case 'language-not-supported':
      return { restart: false, delayMs: 0, notice: LANGUAGE_UNSUPPORTED_NOTICE };
    case 'audio-capture':
      return { restart: false, delayMs: 0, notice: NO_MIC_NOTICE };
    default:
      // An error this table doesn't know: treat it like a network hiccup (keep
      // retrying with backoff), but stay quiet on the very first attempt so a
      // one-off, self-correcting blip doesn't flash a banner.
      return { restart: true, delayMs: backoffMs(attempt), notice: attempt === 0 ? null : RECONNECTING_NOTICE };
  }
}

/** Lowercase, strip Unicode punctuation, collapse whitespace, and trim. */
export function normalizeForEcho(s: string): string {
  return s
    .toLowerCase()
    .replace(/\p{P}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Chrome splits in-progress speech into several results and is inconsistent about
 * the separator: en-US chunks usually start with a space, hi-IN chunks (Chrome 153,
 * verified) don't — plain concatenation glued words together ("नमस्तेआज").
 */
export function joinTranscripts(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ');
}

// A superset only counts as an echo when what was spoken is most of what was heard
// (the echo plus a stray word). Below this, it's a real reply that quotes the partner.
const ECHO_SUPERSET_SHARE = 0.7;

/**
 * True when `text` closely matches something this browser spoke recently — this
 * browser's mic hearing its own TTS output, in *my* language, about to loop back to
 * the partner. Echo shapes: equal, or `text` is part of what was spoken (recognition
 * resumed mid-sentence), or `text` is what was spoken plus a little. A reply that
 * merely *contains* the spoken line ("I'm fine, how are you?" after hearing "how
 * are you") is NOT an echo — dropping it lost real speech. Only when the shorter
 * side has at least 6 characters, so short replies ("да", "okay") are never dropped.
 *
 * ponytail: text similarity is a heuristic, not proof of an actual audio loop. The
 * real guard is pausing recognition while TTS speaks (done by the caller); this
 * only catches the tail of an utterance that outlived that pause.
 */
export function isEcho(text: string, recentSpoken: readonly { text: string; at: number }[], now: number, windowMs = 8000): boolean {
  const heard = normalizeForEcho(text);
  if (!heard) return false;

  for (const recent of recentSpoken) {
    if (now - recent.at > windowMs) continue;
    const spoken = normalizeForEcho(recent.text);
    if (!spoken || Math.min(heard.length, spoken.length) < 6) continue;
    if (spoken.includes(heard)) return true;
    if (heard.includes(spoken) && spoken.length >= heard.length * ECHO_SUPERSET_SHARE) return true;
  }
  return false;
}
