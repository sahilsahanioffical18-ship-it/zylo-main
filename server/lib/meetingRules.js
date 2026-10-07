const { randomInt } = require('node:crypto');

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function letters(count) {
  let out = '';
  for (let i = 0; i < count; i++) out += String.fromCharCode(97 + randomInt(26));
  return out;
}

function generateCode() {
  return `${letters(3)}-${letters(4)}-${letters(3)}`;
}

function isValidCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

// A Translator Convo is a 2-seat, link-shared, instant call: scheduling and
// invites don't apply, and it never waits for a host, so admission is always
// auto and the seat count is always 2. Everything else about it is a normal
// meeting.
const TRANSLATOR_INSTANT_MSG = 'A Translator Convo starts right away and is shared by link.';

function validateCreateMeeting(body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};

  const mode = b.mode ?? 'standard';
  if (mode !== 'standard' && mode !== 'translator') return { error: 'mode must be standard or translator.' };
  const isTranslator = mode === 'translator';

  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length > 120) return { error: 'Title must be 120 characters or fewer.' };

  const isScheduled = b.scheduledFor !== undefined && b.scheduledFor !== null && b.scheduledFor !== '';
  if (isTranslator && isScheduled) return { error: TRANSLATOR_INSTANT_MSG };
  let scheduledFor = null;
  if (isScheduled) {
    if (!title) return { error: 'A scheduled meeting needs a title.' };
    const time = Date.parse(b.scheduledFor);
    if (Number.isNaN(time)) return { error: 'scheduledFor must be an ISO date.' };
    if (time <= now) return { error: 'Pick a time in the future.' };
    if (time > now + 365 * DAY_MS) return { error: 'Meetings can be scheduled up to a year ahead.' };
    scheduledFor = new Date(time).toISOString();
  }

  const admission = isTranslator ? 'auto' : (b.admission ?? 'auto');
  if (admission !== 'auto' && admission !== 'manual') return { error: 'admission must be auto or manual.' };

  const screenSharePolicy = b.screenSharePolicy ?? 'anyone';
  if (screenSharePolicy !== 'anyone' && screenSharePolicy !== 'host_only') {
    return { error: 'screenSharePolicy must be anyone or host_only.' };
  }

  const maxParticipants = isTranslator ? 2 : (b.maxParticipants ?? 20);
  if (!Number.isInteger(maxParticipants) || maxParticipants < 2 || maxParticipants > 20) {
    return { error: 'maxParticipants must be a whole number from 2 to 20.' };
  }

  const rawEmails = b.inviteEmails ?? [];
  if (!Array.isArray(rawEmails)) return { error: 'inviteEmails must be a list.' };
  const inviteEmails = [...new Set(rawEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (isTranslator && inviteEmails.length > 0) return { error: TRANSLATOR_INSTANT_MSG };
  if (inviteEmails.length > 20) return { error: 'You can invite up to 20 people.' };
  const invalid = inviteEmails.find((e) => !EMAIL_RE.test(e));
  if (invalid) return { error: `"${invalid}" is not a valid email.` };

  return {
    value: {
      mode,
      title: title || (isTranslator ? 'Translator Convo' : 'Instant meeting'),
      scheduledFor,
      admission,
      screenSharePolicy,
      maxParticipants,
      inviteEmails,
    },
  };
}

module.exports = { generateCode, isValidCode, validateCreateMeeting };
