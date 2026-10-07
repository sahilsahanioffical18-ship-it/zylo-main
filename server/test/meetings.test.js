const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../app');
const { listen, fakeAuth, setupTestDb, unlimitedLimiter } = require('./helpers');

const HOUR = 60 * 60 * 1000;
let db;
let server;

async function api(userId, method, path, body) {
  const res = await fetch(`${server.base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(userId ? { 'x-test-user': userId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  db = await setupTestDb();
  await db.query(
    `INSERT INTO users (id, email, name) VALUES
     ('user_alice', 'alice@example.com', 'Alice'),
     ('user_bob', 'bob@example.com', 'Bob'),
     ('user_carol', 'carol@example.com', 'Carol')`,
  );
  server = await listen(createApp({ db, auth: fakeAuth, limiter: unlimitedLimiter }));
});

after(async () => {
  await server.close();
  await db.close();
});

test('requests without a user are rejected with 401', async () => {
  assert.equal((await api(null, 'GET', '/dashboard')).status, 401);
});

test('POST /meetings creates an instant meeting hosted by the caller', async () => {
  const { status, body } = await api('user_alice', 'POST', '/meetings', {});
  assert.equal(status, 201);
  assert.match(body.meeting.id, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.equal(body.meeting.title, 'Instant meeting');
  assert.equal(body.meeting.status, 'scheduled');
  assert.equal(body.meeting.isHost, true);
  assert.deepEqual(body.meeting.host, { name: 'Alice' });
  assert.equal(body.meeting.maxParticipants, 20);
});

test('POST /meetings defaults to mode standard', async () => {
  const { status, body } = await api('user_alice', 'POST', '/meetings', {});
  assert.equal(status, 201);
  assert.equal(body.meeting.mode, 'standard');
});

test('POST /meetings with mode translator returns a 2-seat, auto-admission card', async () => {
  const { status, body } = await api('user_alice', 'POST', '/meetings', { mode: 'translator' });
  assert.equal(status, 201);
  assert.equal(body.meeting.mode, 'translator');
  assert.equal(body.meeting.maxParticipants, 2);
  assert.equal(body.meeting.admission, 'auto');
  assert.equal(body.meeting.title, 'Translator Convo');
});

test('POST /meetings rejects invalid input with 400', async () => {
  const { status, body } = await api('user_alice', 'POST', '/meetings', { maxParticipants: 50 });
  assert.equal(status, 400);
  assert.match(body.error, /maxParticipants/);
});

test('scheduled meeting shows in Upcoming for host and invitee only; instant meetings do not', async () => {
  const scheduledFor = new Date(Date.now() + 2 * HOUR).toISOString();
  const created = await api('user_alice', 'POST', '/meetings', {
    title: 'Design review',
    scheduledFor,
    admission: 'manual',
    inviteEmails: ['BOB@example.com'],
  });
  assert.equal(created.status, 201);
  const id = created.body.meeting.id;

  const alice = (await api('user_alice', 'GET', '/dashboard')).body;
  const bob = (await api('user_bob', 'GET', '/dashboard')).body;
  const carol = (await api('user_carol', 'GET', '/dashboard')).body;

  const aliceCard = alice.upcoming.find((m) => m.id === id);
  assert.ok(aliceCard);
  assert.equal(aliceCard.isHost, true);
  assert.equal(aliceCard.admission, 'manual');
  assert.equal(aliceCard.scheduledFor, scheduledFor);
  assert.equal(bob.upcoming.find((m) => m.id === id).isHost, false);
  assert.equal(carol.upcoming.some((m) => m.id === id), false);
  assert.equal(alice.upcoming.some((m) => m.title === 'Instant meeting'), false);
});

test('GET /meetings/:id is available to any signed-in user; 404 unknown, 400 malformed', async () => {
  const id = (await api('user_alice', 'POST', '/meetings', {})).body.meeting.id;
  const asCarol = await api('user_carol', 'GET', `/meetings/${id}`);
  assert.equal(asCarol.status, 200);
  assert.equal(asCarol.body.isHost, false);
  assert.equal(asCarol.body.meeting.id, id);
  assert.equal((await api('user_carol', 'GET', '/meetings/zzz-zzzz-zzz')).status, 404);
  assert.equal((await api('user_carol', 'GET', '/meetings/NOT_A_CODE')).status, 400);
});

test('cards say whether AI is on for the meeting and set up on this server', async () => {
  const created = (await api('user_alice', 'POST', '/meetings', {})).body.meeting;
  assert.equal(created.aiEnabled, true);
  assert.equal(created.aiAvailable, false); // this suite's app was made without AI

  await db.query('UPDATE meetings SET ai_enabled = false WHERE id = $1', [created.id]);
  const withAi = await listen(
    createApp({ db, auth: fakeAuth, limiter: unlimitedLimiter, ai: { model: 'test-model', stream: async () => 'unused' } }),
  );
  try {
    const res = await fetch(`${withAi.base}/api/meetings/${created.id}`, { headers: { 'x-test-user': 'user_bob' } });
    const { meeting } = await res.json();
    assert.equal(meeting.aiEnabled, false);
    assert.equal(meeting.aiAvailable, true);
  } finally {
    await withAi.close();
  }
});

test('cards say whether AI nudges are on for the meeting', async () => {
  const created = (await api('user_alice', 'POST', '/meetings', {})).body.meeting;
  assert.equal(created.aiNudges, false);
  await db.query('UPDATE meetings SET ai_nudges = true WHERE id = $1', [created.id]);
  assert.equal((await api('user_bob', 'GET', `/meetings/${created.id}`)).body.meeting.aiNudges, true);
});

test('DELETE /meetings/:id — only the host, only before it starts', async () => {
  const id = (await api('user_alice', 'POST', '/meetings', {})).body.meeting.id;
  assert.equal((await api('user_bob', 'DELETE', `/meetings/${id}`)).status, 403);
  assert.equal((await api('user_alice', 'DELETE', `/meetings/${id}`)).status, 204);
  assert.equal((await api('user_alice', 'GET', `/meetings/${id}`)).status, 404);
  assert.equal((await api('user_alice', 'DELETE', `/meetings/${id}`)).status, 404);

  const started = (await api('user_alice', 'POST', '/meetings', {})).body.meeting.id;
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [started]);
  assert.equal((await api('user_alice', 'DELETE', `/meetings/${started}`)).status, 409);
});

test('live and previous buckets', async () => {
  const liveId = (await api('user_alice', 'POST', '/meetings', { title: 'Standup' })).body.meeting.id;
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [liveId]);
  await db.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, role) VALUES ($1, 'user_alice', 'host')`,
    [liveId],
  );
  const aliceLive = (await api('user_alice', 'GET', '/dashboard')).body.live.find((m) => m.id === liveId);
  assert.equal(aliceLive.status, 'live');

  const endedId = (await api('user_alice', 'POST', '/meetings', { title: 'Retro' })).body.meeting.id;
  await db.query(
    `UPDATE meetings SET started_at = now() - interval '1 hour', ended_at = now() WHERE id = $1`,
    [endedId],
  );
  await db.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, role) VALUES ($1, 'user_alice', 'host'), ($1, 'user_bob', 'participant')`,
    [endedId],
  );

  const bobPrev = (await api('user_bob', 'GET', '/dashboard')).body.previous.find((m) => m.id === endedId);
  assert.equal(bobPrev.status, 'ended');
  assert.deepEqual(bobPrev.participants.map((p) => p.name).sort(), ['Alice', 'Bob']);
  assert.equal((await api('user_carol', 'GET', '/dashboard')).body.previous.some((m) => m.id === endedId), false);
});
