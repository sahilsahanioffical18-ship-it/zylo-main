const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CONVO_LANGS } = require('../lib/captionRules');

// captionRules.CONVO_LANGS is the server twin of web/lib/convo-languages.ts. If
// the web adds a language the server doesn't know, that person's captions are
// silently dropped; this fails first instead.
test('server CONVO_LANGS matches the web language table, in order', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../web/lib/convo-languages.ts'), 'utf8');
  const webCodes = [...source.matchAll(/\bcode: '([a-z]+)'/g)].map((m) => m[1]);
  assert.equal(webCodes.length, 18);
  assert.deepEqual([...CONVO_LANGS], webCodes);
});
