// The 18-language table for Zylo Translator Convo: one row per language, shared by
// the language selects, capability checks and (eventually) the caption pipeline.
// Zero local imports, free of React and the DOM, so node --test can run it.
// Twin of server/lib/captionRules.js's CONVO_LANGS (codes only) — the server test
// suite has a drift guard that parses this file's codes out and compares them.

export type ConvoLanguage = {
  code: string;
  /** Which section of the language pickers it's listed under. */
  group: 'indian' | 'foreign';
  name: string;
  nativeName: string;
  /** BCP-47 tag for Web Speech (SpeechRecognition.lang). */
  stt: string;
  /** Chrome Translator API language code, or null where Chrome doesn't support it. */
  onDevice: string | null;
  /** MyMemory free-API language code. */
  mymemory: string;
  dir: 'ltr' | 'rtl';
  /** A short greeting meaning "Hello, how are you today?", for capability tests. */
  sample: string;
};

export const CONVO_LANGUAGES: ConvoLanguage[] = [
  { code: 'hi', group: 'indian', name: 'Hindi', nativeName: 'हिन्दी', stt: 'hi-IN', onDevice: 'hi', mymemory: 'hi', dir: 'ltr', sample: 'नमस्ते, आज आप कैसे हैं?' },
  { code: 'bn', group: 'indian', name: 'Bengali', nativeName: 'বাংলা', stt: 'bn-IN', onDevice: 'bn', mymemory: 'bn', dir: 'ltr', sample: 'হ্যালো, আজ আপনি কেমন আছেন?' },
  { code: 'ta', group: 'indian', name: 'Tamil', nativeName: 'தமிழ்', stt: 'ta-IN', onDevice: 'ta', mymemory: 'ta', dir: 'ltr', sample: 'வணக்கம், இன்று நீங்கள் எப்படி இருக்கிறீர்கள்?' },
  { code: 'te', group: 'indian', name: 'Telugu', nativeName: 'తెలుగు', stt: 'te-IN', onDevice: 'te', mymemory: 'te', dir: 'ltr', sample: 'నమస్కారం, ఈరోజు మీరు ఎలా ఉన్నారు?' },
  { code: 'mr', group: 'indian', name: 'Marathi', nativeName: 'मराठी', stt: 'mr-IN', onDevice: 'mr', mymemory: 'mr', dir: 'ltr', sample: 'नमस्कार, आज तुम्ही कसे आहात?' },
  { code: 'gu', group: 'indian', name: 'Gujarati', nativeName: 'ગુજરાતી', stt: 'gu-IN', onDevice: null, mymemory: 'gu', dir: 'ltr', sample: 'નમસ્તે, આજે તમે કેમ છો?' },
  { code: 'kn', group: 'indian', name: 'Kannada', nativeName: 'ಕನ್ನಡ', stt: 'kn-IN', onDevice: 'kn', mymemory: 'kn', dir: 'ltr', sample: 'ನಮಸ್ಕಾರ, ಇಂದು ನೀವು ಹೇಗಿದ್ದೀರಿ?' },
  { code: 'ml', group: 'indian', name: 'Malayalam', nativeName: 'മലയാളം', stt: 'ml-IN', onDevice: null, mymemory: 'ml', dir: 'ltr', sample: 'ഹലോ, ഇന്ന് നിങ്ങൾക്ക് സുഖമാണോ?' },
  { code: 'ur', group: 'indian', name: 'Urdu', nativeName: 'اردو', stt: 'ur-PK', onDevice: null, mymemory: 'ur', dir: 'rtl', sample: 'ہیلو، آج آپ کیسے ہیں؟' },
  { code: 'en', group: 'foreign', name: 'English', nativeName: 'English', stt: 'en-US', onDevice: 'en', mymemory: 'en', dir: 'ltr', sample: 'Hello, how are you today?' },
  { code: 'ru', group: 'foreign', name: 'Russian', nativeName: 'Русский', stt: 'ru-RU', onDevice: 'ru', mymemory: 'ru', dir: 'ltr', sample: 'Привет, как у тебя дела сегодня?' },
  { code: 'es', group: 'foreign', name: 'Spanish', nativeName: 'Español', stt: 'es-ES', onDevice: 'es', mymemory: 'es', dir: 'ltr', sample: 'Hola, ¿cómo estás hoy?' },
  { code: 'fr', group: 'foreign', name: 'French', nativeName: 'Français', stt: 'fr-FR', onDevice: 'fr', mymemory: 'fr', dir: 'ltr', sample: "Bonjour, comment vas-tu aujourd'hui ?" },
  { code: 'de', group: 'foreign', name: 'German', nativeName: 'Deutsch', stt: 'de-DE', onDevice: 'de', mymemory: 'de', dir: 'ltr', sample: 'Hallo, wie geht es dir heute?' },
  { code: 'ar', group: 'foreign', name: 'Arabic', nativeName: 'العربية', stt: 'ar-SA', onDevice: 'ar', mymemory: 'ar', dir: 'rtl', sample: 'مرحبًا، كيف حالك اليوم؟' },
  { code: 'zh', group: 'foreign', name: 'Chinese', nativeName: '中文', stt: 'zh-CN', onDevice: 'zh', mymemory: 'zh-CN', dir: 'ltr', sample: '你好,你今天怎么样?' },
  { code: 'ja', group: 'foreign', name: 'Japanese', nativeName: '日本語', stt: 'ja-JP', onDevice: 'ja', mymemory: 'ja', dir: 'ltr', sample: 'こんにちは、今日の調子はどうですか?' },
  { code: 'pt', group: 'foreign', name: 'Portuguese', nativeName: 'Português', stt: 'pt-BR', onDevice: 'pt', mymemory: 'pt', dir: 'ltr', sample: 'Olá, como você está hoje?' },
];

// The pickers' two sections, in table order (Indian first).
export const LANGUAGE_GROUPS: { label: string; languages: ConvoLanguage[] }[] = [
  { label: 'Indian languages', languages: CONVO_LANGUAGES.filter((l) => l.group === 'indian') },
  { label: 'Foreign languages', languages: CONVO_LANGUAGES.filter((l) => l.group === 'foreign') },
];

export function languageFor(code: string): ConvoLanguage | undefined {
  return CONVO_LANGUAGES.find((l) => l.code === code);
}

export function defaultLanguage(navigatorLanguages: readonly string[]): string {
  for (const tag of navigatorLanguages) {
    const primary = tag.split('-')[0]?.toLowerCase();
    if (primary && CONVO_LANGUAGES.some((l) => l.code === primary)) return primary;
  }
  return 'en';
}
