// Twin of web/lib/convo-languages.ts — the two lists must name the same codes;
// test/convoLangs.test.js fails if they drift.

const CONVO_LANGS = Object.freeze([
  'hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'ur', 'en', 'ru', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'pt',
]);

function isConvoLang(x) {
  return typeof x === 'string' && CONVO_LANGS.includes(x);
}

const ID_RE = /^[a-z0-9-]{1,32}$/;
const MAX_CAPTION_LENGTH = 500;
const MAX_TRANSLATION_LENGTH = 1000;

// Twin of chatRules' validateChatText, but for the convo:caption payload. A bad
// translation attachment drops only the attachment, not the caption — the
// caption is the thing that actually needs to arrive; the translation is a
// bonus the receiver can also produce itself.
function validateCaption(payload) {
  if (typeof payload !== 'object' || payload === null) return null;
  const { id, text, lang, final, translation } = payload;

  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_CAPTION_LENGTH) return null;
  if (!isConvoLang(lang)) return null;
  if (typeof final !== 'boolean') return null;

  const clean = { id, text: trimmed, lang, final };
  const cleanTranslation = validateTranslation(translation);
  if (cleanTranslation) clean.translation = cleanTranslation;
  return clean;
}

function validateTranslation(translation) {
  if (typeof translation !== 'object' || translation === null) return null;
  const { lang, text } = translation;
  if (!isConvoLang(lang)) return null;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_TRANSLATION_LENGTH) return null;
  return { lang, text: trimmed };
}

module.exports = {
  CONVO_LANGS,
  isConvoLang,
  MAX_CAPTION_LENGTH,
  MAX_TRANSLATION_LENGTH,
  validateCaption,
};
