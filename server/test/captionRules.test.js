const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateCaption,
  MAX_CAPTION_LENGTH,
  MAX_TRANSLATION_LENGTH,
} = require('../lib/captionRules');

const base = () => ({ id: 'abc-123', text: 'hello there', lang: 'hi', final: true });

test('a valid payload comes back clean', () => {
  assert.deepEqual(validateCaption(base()), { id: 'abc-123', text: 'hello there', lang: 'hi', final: true });
});

test('rejects a bad id', () => {
  for (const id of ['', 'UPPER', 'has spaces', 'x'.repeat(33), 'emoji-🙂', 42, null, undefined]) {
    assert.equal(validateCaption({ ...base(), id }), null, JSON.stringify(id));
  }
});

test('rejects empty or whitespace-only text', () => {
  for (const text of ['', '   ', '\n\t ']) {
    assert.equal(validateCaption({ ...base(), text }), null, JSON.stringify(text));
  }
});

test('rejects text over 500 characters (after trimming), accepts exactly 500', () => {
  assert.equal(validateCaption({ ...base(), text: 'x'.repeat(MAX_CAPTION_LENGTH + 1) }), null);
  assert.equal(validateCaption({ ...base(), text: 'x'.repeat(MAX_CAPTION_LENGTH) }).text.length, MAX_CAPTION_LENGTH);
  // trimmed length is what's measured
  assert.equal(validateCaption({ ...base(), text: '  ' + 'x'.repeat(MAX_CAPTION_LENGTH) + '  ' }).text.length, MAX_CAPTION_LENGTH);
});

test('rejects a bad lang', () => {
  for (const lang of ['xx', '', 'HI', 42, null, undefined]) {
    assert.equal(validateCaption({ ...base(), lang }), null, JSON.stringify(lang));
  }
});

test('rejects final that is not a real boolean', () => {
  for (const final of ['true', 'false', 1, 0, null, undefined]) {
    assert.equal(validateCaption({ ...base(), final }), null, JSON.stringify(final));
  }
  assert.ok(validateCaption({ ...base(), final: false }));
});

test('rejects non-object input', () => {
  for (const bad of [null, undefined, 42, 'string', [], true]) {
    assert.equal(validateCaption(bad), null, String(bad));
  }
});

test('strips unknown keys', () => {
  const clean = validateCaption({ ...base(), evil: 'haxx0r', userId: 'forged', name: 'Impostor' });
  assert.deepEqual(Object.keys(clean).sort(), ['final', 'id', 'lang', 'text']);
});

test('drops only the translation when it is invalid, keeping the caption', () => {
  for (const translation of [
    { lang: 'xx', text: 'bad lang' },
    { lang: 'ru', text: '' },
    { lang: 'ru', text: '   ' },
    { lang: 'ru', text: 'x'.repeat(MAX_TRANSLATION_LENGTH + 1) },
    { lang: 'ru' }, // missing text
    { text: 'no lang' },
    'not an object',
    42,
  ]) {
    const clean = validateCaption({ ...base(), translation });
    assert.ok(clean, JSON.stringify(translation));
    assert.equal(clean.translation, undefined, JSON.stringify(translation));
  }
});

test('keeps a valid translation, trimmed', () => {
  const clean = validateCaption({ ...base(), translation: { lang: 'ru', text: '  привет  ' } });
  assert.deepEqual(clean.translation, { lang: 'ru', text: 'привет' });
});

test('accepts translation text at exactly 1000 characters', () => {
  const clean = validateCaption({ ...base(), translation: { lang: 'ru', text: 'x'.repeat(MAX_TRANSLATION_LENGTH) } });
  assert.equal(clean.translation.text.length, MAX_TRANSLATION_LENGTH);
});
