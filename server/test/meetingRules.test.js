const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateCode, isValidCode, validateCreateMeeting } = require('../lib/meetingRules');

const NOW = Date.parse('2026-09-15T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

test('generateCode always matches the meeting code format', () => {
  for (let i = 0; i < 1000; i++) assert.match(generateCode(), /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
});

test('isValidCode accepts only the exact format', () => {
  assert.equal(isValidCode('abc-defg-hij'), true);
  for (const bad of ['ABC-defg-hij', 'abc-def-ghi', 'abc-defg-hijk', '', 42, null]) {
    assert.equal(isValidCode(bad), false, String(bad));
  }
});

test('empty body gives instant-meeting defaults, mode standard', () => {
  assert.deepEqual(validateCreateMeeting({}, NOW), {
    value: {
      mode: 'standard',
      title: 'Instant meeting',
      scheduledFor: null,
      admission: 'auto',
      screenSharePolicy: 'anyone',
      maxParticipants: 20,
      inviteEmails: [],
    },
  });
});

test('mode must be standard or translator', () => {
  assert.match(validateCreateMeeting({ mode: 'group' }, NOW).error, /mode/);
  assert.equal(validateCreateMeeting({ mode: 'standard' }, NOW).value.mode, 'standard');
});

test('translator mode forces 2 seats and auto admission, ignoring input', () => {
  const { value } = validateCreateMeeting({ mode: 'translator', maxParticipants: 20, admission: 'manual' }, NOW);
  assert.equal(value.mode, 'translator');
  assert.equal(value.maxParticipants, 2);
  assert.equal(value.admission, 'auto');
  assert.equal(value.title, 'Translator Convo');
});

test('translator mode rejects scheduledFor and non-empty inviteEmails', () => {
  const inAnHour = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.match(
    validateCreateMeeting({ mode: 'translator', scheduledFor: inAnHour }, NOW).error,
    /starts right away/,
  );
  assert.match(
    validateCreateMeeting({ mode: 'translator', inviteEmails: ['sam@example.com'] }, NOW).error,
    /starts right away/,
  );
});

test('scheduled meetings need a title and a future time within a year', () => {
  const inAnHour = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.match(validateCreateMeeting({ scheduledFor: inAnHour }, NOW).error, /title/);
  assert.match(validateCreateMeeting({ title: 'Sync', scheduledFor: 'not a date' }, NOW).error, /ISO/);
  assert.match(validateCreateMeeting({ title: 'Sync', scheduledFor: new Date(NOW - 1000).toISOString() }, NOW).error, /future/);
  assert.match(validateCreateMeeting({ title: 'Sync', scheduledFor: new Date(NOW + 366 * DAY).toISOString() }, NOW).error, /year/);
  assert.equal(validateCreateMeeting({ title: ' Sync ', scheduledFor: inAnHour }, NOW).value.scheduledFor, inAnHour);
  assert.equal(validateCreateMeeting({ title: ' Sync ', scheduledFor: inAnHour }, NOW).value.title, 'Sync');
});

test('title longer than 120 characters is rejected', () => {
  assert.match(validateCreateMeeting({ title: 'x'.repeat(121) }, NOW).error, /120/);
  assert.equal(validateCreateMeeting({ title: 'x'.repeat(120) }, NOW).value.title.length, 120);
});

test('admission, screen share policy and max participants are checked', () => {
  assert.match(validateCreateMeeting({ admission: 'open' }, NOW).error, /admission/);
  assert.match(validateCreateMeeting({ screenSharePolicy: 'everyone' }, NOW).error, /screenSharePolicy/);
  for (const bad of [1, 21, 2.5, '10']) {
    assert.match(validateCreateMeeting({ maxParticipants: bad }, NOW).error, /maxParticipants/, String(bad));
  }
  const ok = validateCreateMeeting({ admission: 'manual', screenSharePolicy: 'host_only', maxParticipants: 2 }, NOW).value;
  assert.deepEqual([ok.admission, ok.screenSharePolicy, ok.maxParticipants], ['manual', 'host_only', 2]);
});

test('invite emails are trimmed, lowercased, de-duplicated and limited to 20', () => {
  assert.deepEqual(
    validateCreateMeeting({ inviteEmails: [' Priya@Example.com', 'priya@example.com', 'sam@example.com'] }, NOW).value.inviteEmails,
    ['priya@example.com', 'sam@example.com'],
  );
  const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
  assert.match(validateCreateMeeting({ inviteEmails: many }, NOW).error, /20/);
  assert.match(validateCreateMeeting({ inviteEmails: ['not-an-email'] }, NOW).error, /not-an-email/);
  assert.match(validateCreateMeeting({ inviteEmails: 'a@b.com' }, NOW).error, /list/);
});
