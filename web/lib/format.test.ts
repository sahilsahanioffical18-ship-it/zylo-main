import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatWhen, initials, normalizeCode, parseInviteEmails, toDateTimeLocalValue } from './format.ts';

const now = new Date('2026-09-15T10:00:00Z');
const opts = ['en-US', 'UTC'] as const;

test('formatWhen uses relative day names near today', () => {
  assert.equal(formatWhen('2026-09-15T15:00:00Z', now, ...opts), 'Today, 3:00 PM');
  assert.equal(formatWhen('2026-09-16T09:30:00Z', now, ...opts), 'Tomorrow, 9:30 AM');
  assert.equal(formatWhen('2026-09-14T18:00:00Z', now, ...opts), 'Yesterday, 6:00 PM');
  assert.equal(formatWhen('2026-09-17T15:00:00Z', now, ...opts), 'Thu, Sep 17, 3:00 PM');
});

test('formatDuration', () => {
  assert.equal(formatDuration('2026-09-15T10:00:00Z', '2026-09-15T10:00:20Z'), 'Under 1 min');
  assert.equal(formatDuration('2026-09-15T10:00:00Z', '2026-09-15T10:45:00Z'), '45 min');
  assert.equal(formatDuration('2026-09-15T10:00:00Z', '2026-09-15T11:00:00Z'), '1 h');
  assert.equal(formatDuration('2026-09-15T10:00:00Z', '2026-09-15T11:05:00Z'), '1 h 5 min');
});

test('normalizeCode accepts codes and links, rejects junk', () => {
  assert.equal(normalizeCode(' ABC-DEFG-HIJ '), 'abc-defg-hij');
  assert.equal(normalizeCode('http://localhost:3000/m/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(normalizeCode('abc-def-ghi'), null);
  assert.equal(normalizeCode(''), null);
  assert.equal(normalizeCode('abcd-defg-hijk'), null);
  assert.equal(normalizeCode('xabc-defg-hijz'), null);
});

test('initials', () => {
  assert.equal(initials('Priya Sharma'), 'PS');
  assert.equal(initials('sam'), 'S');
  assert.equal(initials('  Ana Maria Lopez '), 'AL');
  assert.equal(initials(''), '?');
});

test('toDateTimeLocalValue pads local date and time', () => {
  assert.equal(toDateTimeLocalValue(new Date(2026, 8, 5, 7, 3)), '2026-09-05T07:03');
});

test('parseInviteEmails splits, lowercases, de-duplicates and flags invalid entries', () => {
  assert.deepEqual(parseInviteEmails(' Priya@Example.com, sam@example.org;priya@example.com\nnot-an-email '), {
    emails: ['priya@example.com', 'sam@example.org', 'not-an-email'],
    invalid: ['not-an-email'],
  });
  assert.deepEqual(parseInviteEmails('   '), { emails: [], invalid: [] });
});
