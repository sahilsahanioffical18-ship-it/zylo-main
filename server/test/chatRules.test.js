const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateChatText, MAX_CHAT_LENGTH } = require('../lib/chatRules');

test('rejects anything that is not a string', () => {
  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.equal(validateChatText(bad), null, String(bad));
  }
});

test('rejects empty and whitespace-only text', () => {
  for (const bad of ['', '   ', '\n\t ', ' ']) {
    assert.equal(validateChatText(bad), null, JSON.stringify(bad));
  }
});

test('measures the 2,000-character limit after trimming', () => {
  assert.equal(validateChatText('x'.repeat(MAX_CHAT_LENGTH)).length, MAX_CHAT_LENGTH);
  assert.equal(validateChatText('x'.repeat(MAX_CHAT_LENGTH + 1)), null);
  assert.equal(validateChatText('  ' + 'x'.repeat(MAX_CHAT_LENGTH) + '  ').length, MAX_CHAT_LENGTH);
  assert.equal(validateChatText('  ' + 'x'.repeat(MAX_CHAT_LENGTH + 1) + ' '), null);
});

test('returns the trimmed text', () => {
  assert.equal(validateChatText('  hello ZyloRoom  '), 'hello ZyloRoom');
});
