// Zylo Translator Convo capability detection: what does *this* browser actually
// support for speech-to-text, on-device translation and voices. Zero local
// imports, free of React and the DOM lib, so node --test can run it against
// hand-made fake globals instead of a real browser.

export type SpeechSupport = 'on-device' | 'on-device-downloadable' | 'cloud' | 'none';
export type TranslatorSupport = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'none';

export type SupportGlobals = {
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
  Translator?: unknown;
  speechSynthesis?: { getVoices(): { name: string; lang: string; localService: boolean }[] };
};

type RecognitionAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
const KNOWN_AVAILABILITY: readonly RecognitionAvailability[] = ['available', 'downloadable', 'downloading', 'unavailable'];

// The shape this module actually reads off a recognition/translator constructor.
// Cast to these locally instead of importing the ambient browser-speech.d.ts
// types, so this stays a zero-import module that plain test fakes can satisfy.
type RecognitionCtorShape = {
  available?: (opts: { langs: string[]; processLocally: boolean }) => unknown;
  prototype?: { processLocally?: unknown };
};

type TranslatorCtorShape = {
  availability: (opts: { sourceLanguage: string; targetLanguage: string }) => unknown;
};

// Some Chromium builds expose Translator/SpeechRecognition.available but never
// settle the promise (seen in an Electron-based Chrome 152). An unbounded await
// would leave the check, and later the live pipeline, stuck forever, so every
// availability probe resolves to its fallback after `ms`.
export const PROBE_TIMEOUT_MS = 4000;
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

export function recognitionCtor(g: SupportGlobals): unknown {
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export async function speechSupport(g: SupportGlobals, sttTag: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<SpeechSupport> {
  const ctor = recognitionCtor(g);
  if (!ctor) return 'none';
  const shape = ctor as RecognitionCtorShape;
  if (typeof shape.available !== 'function') return 'cloud';
  try {
    // Called on the constructor, never detached: a browser that checks the
    // receiver would throw here and the catch below would misreport 'cloud'.
    const status = await settleWithin(Promise.resolve(shape.available({ langs: [sttTag], processLocally: true })), timeoutMs, 'timeout');
    if (status === 'available') return 'on-device';
    if (status === 'downloadable' || status === 'downloading') return 'on-device-downloadable';
    return 'cloud';
  } catch {
    return 'cloud';
  }
}

export function canRecognizeTrack(g: SupportGlobals): boolean {
  // ponytail: there's no clean feature detection for start(MediaStreamTrack) —
  // see https://github.com/WebAudio/web-speech-api/issues/126. Heuristic: Chrome
  // 139+ (which exposes `processLocally` on the prototype) implies Chrome 135+
  // (which shipped start(track)), and Android Chrome has neither. Because this is
  // a heuristic and not a real probe, the hook must still try/catch start(track)
  // rather than trust this blindly. Upgrade: a real capability probe if the
  // upstream issue above ever lands one.
  const ctor = recognitionCtor(g) as RecognitionCtorShape | null;
  return !!ctor?.prototype && 'processLocally' in ctor.prototype;
}

export async function translatorSupport(
  g: SupportGlobals,
  from: string | null,
  to: string | null,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<TranslatorSupport> {
  if (!g.Translator || !from || !to) return 'none';
  const translator = g.Translator as TranslatorCtorShape;
  try {
    const status = await settleWithin(
      Promise.resolve(translator.availability({ sourceLanguage: from, targetLanguage: to })),
      timeoutMs,
      'unavailable',
    );
    return KNOWN_AVAILABILITY.includes(status as RecognitionAvailability) ? (status as RecognitionAvailability) : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

type Voice = { name: string; lang: string; localService: boolean };

// macOS ships joke voices (sound effects, singing) under real locales; they sort
// first alphabetically, so the old picker read every English translation as
// "Albert". Never pick these.
const NOVELTY_VOICES = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;
// Usable but robotic (the Eloquence family and old MacinTalk voices): last resort.
const LEGACY_VOICES = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Fred|Junior|Kathy|Ralph)\b/i;
const QUALITY_VOICES = /google|natural|premium|enhanced|online/i;

const normLang = (lang: string) => lang.replace(/_/g, '-').toLowerCase();

/** Voices for `sttTag`, best first: modern over legacy, exact locale, then quality. */
export function voicesFor(g: SupportGlobals, sttTag: string): Voice[] {
  const tag = sttTag.toLowerCase();
  const primary = tag.split('-')[0];
  const matches = (g.speechSynthesis?.getVoices() ?? []).filter((v) => {
    const lang = normLang(v.lang);
    return !NOVELTY_VOICES.test(v.name) && (lang === tag || lang === primary || lang.startsWith(`${primary}-`));
  });
  const rank = (v: Voice) => [LEGACY_VOICES.test(v.name) ? 1 : 0, normLang(v.lang) === tag ? 0 : 1, QUALITY_VOICES.test(v.name) ? 0 : 1];
  // Array#sort is stable, so equal-rank voices keep the browser's order.
  return matches.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
}

export type VoicePlan =
  | { kind: 'native'; voice: Voice }
  // No device voice: Google's voice, fetched through our server (/api/tts).
  | { kind: 'cloud' }
  | { kind: 'none' };

/**
 * How translations into `code` get spoken on this device. Many desktops lack voices
 * for Indian languages (macOS Chrome: no mr, gu, ml, ur), and speaking their text
 * with the default English voice produced silence or gibberish. `cloud` is false
 * where the online voice can't be used (signed out: /api/tts needs a user).
 */
export function voicePlan(g: SupportGlobals, code: string, sttTag = code, cloud = true): VoicePlan {
  const native = voicesFor(g, sttTag)[0];
  if (native) return { kind: 'native', voice: native };
  return cloud ? { kind: 'cloud' } : { kind: 'none' };
}

/** One line explaining how translations will be heard, or null when a device voice reads them. */
export function voicePlanNote(plan: VoicePlan, languageName: string): string | null {
  switch (plan.kind) {
    case 'native':
      return null;
    case 'cloud':
      return `No ${languageName} voice on this device, so translations are read by Google's online voice.`;
    case 'none':
      return `No ${languageName} voice on this device: captions only. Sign in for Google's online voice, or add a voice in your system's speech settings.`;
  }
}
