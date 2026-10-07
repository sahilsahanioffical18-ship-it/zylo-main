import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldToast, toastPreview } from './chat-toast.ts';

test('no toast for your own message', () => {
  assert.equal(shouldToast({ userId: 'u1' }, 'u1', false), false);
});

test('no toast while chat is visible', () => {
  assert.equal(shouldToast({ userId: 'u2' }, 'u1', true), false);
});

test('someone else\'s message toasts while chat is hidden', () => {
  assert.equal(shouldToast({ userId: 'u2' }, 'u1', false), true);
});

test('a short text is returned unchanged', () => {
  assert.equal(toastPreview('hello there'), 'hello there');
});

test('a long text is cut at a word boundary with an ellipsis', () => {
  const text = `${'a'.repeat(45)} ${'b'.repeat(50)}`;
  assert.equal(toastPreview(text, 80), `${'a'.repeat(45)}…`);
});

test('one long word with no spaces is hard-cut with an ellipsis', () => {
  const text = 'z'.repeat(100);
  assert.equal(toastPreview(text, 80), `${'z'.repeat(80)}…`);
});

test('newlines (and other whitespace runs) are collapsed to single spaces', () => {
  assert.equal(toastPreview('hello\nworld\n\n  foo'), 'hello world foo');
});

test('the output length never exceeds max + 1', () => {
  const preview = toastPreview('word '.repeat(200), 80);
  assert.ok(preview.length <= 81, `expected length <= 81, got ${preview.length}`);
});

test('the cut never splits an emoji surrogate pair', () => {
  const preview = toastPreview(`${'x'.repeat(79)}😀tail`, 80);
  assert.equal(preview, `${'x'.repeat(79)}…`);
});
