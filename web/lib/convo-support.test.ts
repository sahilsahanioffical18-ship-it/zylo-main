import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognitionCtor, speechSupport, canRecognizeTrack, translatorSupport, voicesFor, voicePlan, voicePlanNote } from './convo-support.ts';
import type { SupportGlobals } from './convo-support.ts';

function ctorWithAvailable(available: ((opts: { langs: string[]; processLocally: boolean }) => unknown) | undefined) {
  class Fake {
    static available = available;
  }
  return Fake;
}

test('recognitionCtor prefers the standard constructor over the webkit one', () => {
  const std = class {};
  const webkit = class {};
  assert.equal(recognitionCtor({ SpeechRecognition: std, webkitSpeechRecognition: webkit }), std);
  assert.equal(recognitionCtor({ webkitSpeechRecognition: webkit }), webkit);
  assert.equal(recognitionCtor({}), null);
});

test('speechSupport is none with no recognition constructor at all', async () => {
  assert.equal(await speechSupport({}, 'hi-IN'), 'none');
});

test('speechSupport is cloud when the constructor has no static available', async () => {
  const g: SupportGlobals = { SpeechRecognition: class {} };
  assert.equal(await speechSupport(g, 'hi-IN'), 'cloud');
});

test('speechSupport maps available() statuses', async () => {
  const cases: [string, 'on-device' | 'on-device-downloadable' | 'cloud'][] = [
    ['available', 'on-device'],
    ['downloadable', 'on-device-downloadable'],
    ['downloading', 'on-device-downloadable'],
    ['unavailable', 'cloud'],
    ['something-unexpected', 'cloud'],
  ];
  for (const [status, expected] of cases) {
    const g: SupportGlobals = { SpeechRecognition: ctorWithAvailable(() => status) };
    assert.equal(await speechSupport(g, 'hi-IN'), expected, `status ${status}`);
  }
});

test('speechSupport is cloud when available() throws', async () => {
  const g: SupportGlobals = {
    SpeechRecognition: ctorWithAvailable(() => {
      throw new Error('boom');
    }),
  };
  assert.equal(await speechSupport(g, 'hi-IN'), 'cloud');
});

test('speechSupport is cloud when available() rejects', async () => {
  const g: SupportGlobals = { SpeechRecognition: ctorWithAvailable(() => Promise.reject(new Error('boom'))) };
  assert.equal(await speechSupport(g, 'hi-IN'), 'cloud');
});

test('canRecognizeTrack is true only when the prototype has processLocally', () => {
  // Real browsers define processLocally as a Web IDL accessor on the prototype
  // (not an instance field), so the fake mirrors that rather than a class field.
  class WithTrack {}
  Object.defineProperty(WithTrack.prototype, 'processLocally', { value: true });
  class WithoutTrack {}
  assert.equal(canRecognizeTrack({ SpeechRecognition: WithTrack }), true);
  assert.equal(canRecognizeTrack({ SpeechRecognition: WithoutTrack }), false);
  assert.equal(canRecognizeTrack({}), false);
});

test('translatorSupport is none with no Translator global or a missing language', async () => {
  const g: SupportGlobals = { Translator: { availability: async () => 'available' } };
  assert.equal(await translatorSupport({}, 'hi', 'ru'), 'none');
  assert.equal(await translatorSupport(g, null, 'ru'), 'none');
  assert.equal(await translatorSupport(g, 'hi', null), 'none');
});

test('translatorSupport passes through the four known statuses', async () => {
  for (const status of ['available', 'downloadable', 'downloading', 'unavailable']) {
    const g: SupportGlobals = { Translator: { availability: async () => status } };
    assert.equal(await translatorSupport(g, 'hi', 'ru'), status);
  }
});

test('translatorSupport is unavailable on a throw or an unrecognized status', async () => {
  const throwing: SupportGlobals = {
    Translator: {
      availability: () => {
        throw new Error('boom');
      },
    },
  };
  assert.equal(await translatorSupport(throwing, 'hi', 'ru'), 'unavailable');

  const weird: SupportGlobals = { Translator: { availability: async () => 'maybe' } };
  assert.equal(await translatorSupport(weird, 'hi', 'ru'), 'unavailable');
});

function voice(name: string, lang: string) {
  return { name, lang, localService: true };
}

test('voicesFor matches exact tag, underscore variants and case, plus the prefix', () => {
  const g: SupportGlobals = {
    speechSynthesis: {
      getVoices: () => [
        voice('Microsoft Ravi', 'hi_IN'),
        voice('Some Other', 'fr-FR'),
        voice('Google हिन्दी', 'HI-in'),
        voice('Rishi (Natural)', 'hi-IN'),
      ],
    },
  };
  const names = voicesFor(g, 'hi-IN').map((v) => v.name);
  assert.deepEqual(names.sort(), ['Google हिन्दी', 'Microsoft Ravi', 'Rishi (Natural)'].sort());
});

test('voicesFor sorts an exact tag match first, then Google/Natural, then the rest', () => {
  const g: SupportGlobals = {
    speechSynthesis: {
      getVoices: () => [voice('Plain Hindi', 'hi'), voice('Google Hindi', 'hi'), voice('Exact Tag', 'hi-IN')],
    },
  };
  const names = voicesFor(g, 'hi-IN').map((v) => v.name);
  assert.deepEqual(names, ['Exact Tag', 'Google Hindi', 'Plain Hindi']);
});

test('voicesFor returns nothing for an unrelated language', () => {
  const g: SupportGlobals = { speechSynthesis: { getVoices: () => [voice('French', 'fr-FR')] } };
  assert.deepEqual(voicesFor(g, 'hi-IN'), []);
});

test('voicesFor is empty with no speechSynthesis global', () => {
  assert.deepEqual(voicesFor({}, 'hi-IN'), []);
});

test('an availability probe that never settles falls back instead of hanging', async () => {
  const never = () => new Promise(() => {});
  class Recognition {
    static available = never;
  }
  assert.equal(await speechSupport({ SpeechRecognition: Recognition }, 'hi-IN', 20), 'cloud');
  assert.equal(await translatorSupport({ Translator: { availability: never } }, 'ru', 'hi', 20), 'unavailable');
});

test('voicesFor never picks a macOS novelty voice, and puts legacy robot voices last', () => {
  // Real Chrome 153 on macOS lists en-US novelty voices first alphabetically:
  // the old picker spoke every English translation as "Albert".
  const g: SupportGlobals = {
    speechSynthesis: {
      getVoices: () => [
        voice('Albert', 'en-US'),
        voice('Bad News', 'en-US'),
        voice('Eddy (English (United States))', 'en-US'),
        voice('Fred', 'en-US'),
        voice('Samantha', 'en-US'),
        voice('Google US English', 'en-US'),
        voice('Zarvox', 'en-US'),
      ],
    },
  };
  assert.deepEqual(
    voicesFor(g, 'en-US').map((v) => v.name),
    ['Google US English', 'Samantha', 'Eddy (English (United States))', 'Fred'],
  );
});

test('voicePlan uses a native voice when there is one', () => {
  const g: SupportGlobals = { speechSynthesis: { getVoices: () => [voice('Piya', 'bn-IN'), voice('Lekha', 'hi-IN')] } };
  assert.deepEqual(voicePlan(g, 'bn'), { kind: 'native', voice: voice('Piya', 'bn-IN') });
});

test('voicePlan falls back to the online (Google) voice when the device has none', () => {
  // macOS Chrome: a Hindi voice, but none for Marathi, Gujarati, Malayalam or Urdu.
  const g: SupportGlobals = { speechSynthesis: { getVoices: () => [voice('Lekha', 'hi-IN'), voice('Samantha', 'en-US')] } };
  for (const code of ['mr', 'gu', 'ml', 'ur']) assert.deepEqual(voicePlan(g, code), { kind: 'cloud' }, code);
  assert.deepEqual(voicePlan({}, 'hi'), { kind: 'cloud' }); // no speechSynthesis at all (Firefox without voices)
});

test('voicePlan is none when there is no device voice and the online voice is off (signed out)', () => {
  const g: SupportGlobals = { speechSynthesis: { getVoices: () => [voice('Samantha', 'en-US')] } };
  assert.deepEqual(voicePlan(g, 'gu', 'gu-IN', false), { kind: 'none' });
  // A device voice never needs the online one.
  assert.deepEqual(voicePlan(g, 'en', 'en-US', false), { kind: 'native', voice: voice('Samantha', 'en-US') });
});

test('voicePlanNote says nothing for a device voice and explains the online and captions-only cases', () => {
  assert.equal(voicePlanNote({ kind: 'native', voice: voice('Piya', 'bn-IN') }, 'Bengali'), null);
  assert.match(voicePlanNote({ kind: 'cloud' }, 'Gujarati')!, /No Gujarati voice on this device.*Google/);
  assert.match(voicePlanNote({ kind: 'none' }, 'Arabic')!, /No Arabic voice.*captions only/);
});
