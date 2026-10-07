import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONVO_LANGUAGES, LANGUAGE_GROUPS, languageFor, defaultLanguage } from './convo-languages.ts';

test('there are 18 languages with unique codes', () => {
  assert.equal(CONVO_LANGUAGES.length, 18);
  assert.equal(new Set(CONVO_LANGUAGES.map((l) => l.code)).size, 18);
});

test('every stt tag primary subtag equals the code', () => {
  for (const lang of CONVO_LANGUAGES) {
    assert.equal(lang.stt.split('-')[0].toLowerCase(), lang.code, `${lang.code}: stt is ${lang.stt}`);
  }
});

test('onDevice is null only for gu, ml and ur', () => {
  const nullCodes = CONVO_LANGUAGES.filter((l) => l.onDevice === null).map((l) => l.code).sort();
  assert.deepEqual(nullCodes, ['gu', 'ml', 'ur']);
});

test('rtl is set only for ar and ur', () => {
  const rtlCodes = CONVO_LANGUAGES.filter((l) => l.dir === 'rtl').map((l) => l.code).sort();
  assert.deepEqual(rtlCodes, ['ar', 'ur']);
});

test('languageFor finds a known code and misses an unknown one', () => {
  assert.equal(languageFor('hi')?.name, 'Hindi');
  assert.equal(languageFor('xx'), undefined);
});

test('defaultLanguage matches the browser language primary subtag', () => {
  assert.equal(defaultLanguage(['ru-RU']), 'ru');
  assert.equal(defaultLanguage(['fr-CA']), 'fr');
});

test('defaultLanguage falls back to en for an unknown or empty list', () => {
  assert.equal(defaultLanguage(['xx']), 'en');
  assert.equal(defaultLanguage([]), 'en');
});

test('languages split into an Indian and a foreign group that together cover all 18', () => {
  assert.deepEqual(
    LANGUAGE_GROUPS.map((g) => g.label),
    ['Indian languages', 'Foreign languages'],
  );
  const [indian, foreign] = LANGUAGE_GROUPS.map((g) => g.languages.map((l) => l.code));
  assert.deepEqual(indian, ['hi', 'bn', 'ta', 'te', 'mr', 'gu', 'kn', 'ml', 'ur']);
  assert.deepEqual(foreign, ['en', 'ru', 'es', 'fr', 'de', 'ar', 'zh', 'ja', 'pt']);
});
