import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChatText, MAX_CHAT_LENGTH } from './chat-rules.ts';

test('rejects anything that is not a string', () => {
  for (const bad of [undefined, null, 42, {}, [], true] as unknown[]) {
    assert.equal(validateChatText(bad as string), null, String(bad));
  }
});

test('rejects empty and whitespace-only text', () => {
  for (const bad of ['', '   ', '\n\t ', ' ']) {
    assert.equal(validateChatText(bad), null, JSON.stringify(bad));
  }
});

test('measures the 2,000-character limit after trimming', () => {
  assert.equal(validateChatText('x'.repeat(MAX_CHAT_LENGTH))?.length, MAX_CHAT_LENGTH);
  assert.equal(validateChatText('x'.repeat(MAX_CHAT_LENGTH + 1)), null);
  assert.equal(validateChatText('  ' + 'x'.repeat(MAX_CHAT_LENGTH) + '  ')?.length, MAX_CHAT_LENGTH);
  assert.equal(validateChatText('  ' + 'x'.repeat(MAX_CHAT_LENGTH + 1) + ' '), null);
});

test('returns the trimmed text', () => {
  assert.equal(validateChatText('  hello ZyloRoom  '), 'hello ZyloRoom');
});
