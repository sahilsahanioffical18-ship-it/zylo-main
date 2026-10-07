const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAi } = require('../lib/ai');
const { roomHarness, collect, settle, waitForEvent, takeOverSeat, startFakeAi, aiAnswer } = require('./helpers');

// A provider client pointed at a fake OpenAI-compatible server (helpers.js).
async function fakeAi(t, respond, options = {}) {
  const provider = await startFakeAi(t, respond);
  return { provider, ai: createAi({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model', ...options }) };
}

// Every answer event one client hears, in order, as [event, payload].
function aiEvents(socket) {
  const got = [];
  for (const event of ['ai:start', 'ai:chunk', 'ai:done', 'ai:failed']) socket.on(event, (payload) => got.push([event, payload]));
  return got;
}

// Refuses one policy and records every take, so the order of the checks shows.
function refusingLimiter(policy) {
  const takes = [];
  return {
    takes,
    take: async (name, id) => {
      takes.push([name, id]);
      return { allowed: name !== policy, remaining: 0, retryAfterMs: 10_000 };
    },
  };
}

// ── The host's "AI in chat" setting ──────────────────────────────────────────

test('host:set-ai turns AI off and on: saved in the store and Postgres, told to the room', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const settings = collect(p1, 'meeting:settings');

  host.emit('host:set-ai', { enabled: false });
  await settle();
  assert.deepEqual(settings, [{ admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: false, aiNudges: false }]);
  assert.equal((await store.getMeta(meetingId)).aiEnabled, false);
  const { rows } = await db.query('SELECT ai_enabled FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ai_enabled, false);

  host.emit('host:set-ai', { enabled: true });
  await settle();
  assert.deepEqual(settings.at(-1), { admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: true, aiNudges: false });
  assert.equal((await store.getMeta(meetingId)).aiEnabled, true);
});

test('host:set-ai is host-only and ignores anything but a boolean', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const settings = collect(host, 'meeting:settings');
  const forbidden = waitForEvent(p1, 'error:forbidden');
  p1.emit('host:set-ai', { enabled: false });
  await forbidden;
  host.emit('host:set-ai', { enabled: 'false' });
  host.emit('host:set-ai', {});
  await settle();
  assert.equal(settings.length, 0);
  assert.equal((await store.getMeta(meetingId)).aiEnabled, true);
  const { rows } = await db.query('SELECT ai_enabled FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ai_enabled, true);
});

test('host:set-ai is ignored in a translator convo', async (t) => {
  const { meetingId, store, join } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });
  const host = await join('host');
  const settings = collect(host, 'meeting:settings');
  host.emit('host:set-ai', { enabled: false });
  await settle();
  assert.equal(settings.length, 0);
  assert.equal((await store.getMeta(meetingId)).aiEnabled, true);
});

test('a meeting saved with AI off starts with it off, and every settings broadcast says so', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  await db.query('UPDATE meetings SET ai_enabled = false WHERE id = $1', [meetingId]);
  const host = await join('host');
  assert.equal((await store.getMeta(meetingId)).aiEnabled, false);
  const settings = collect(host, 'meeting:settings');
  host.emit('host:set-admission', { mode: 'manual' });
  await settle();
  host.emit('host:set-screen-policy', { policy: 'host_only' });
  await settle();
  assert.deepEqual(settings, [
    { admission: 'manual', screenSharePolicy: 'anyone', aiEnabled: false, aiNudges: false },
    { admission: 'manual', screenSharePolicy: 'host_only', aiEnabled: false, aiNudges: false },
  ]);
});

test('someone admitted from the lobby is sent the settings as they are now, before "admitted"', async (t) => {
  const { meetingId, connect, join } = await roomHarness(t, { admission: 'manual' });
  const host = await join('host');
  const p1 = connect('p1');
  const waiting = waitForEvent(p1, 'meeting:waiting');
  p1.emit('meeting:join-request', { meetingId });
  await waiting;
  const off = waitForEvent(host, 'meeting:settings');
  host.emit('host:set-ai', { enabled: false }); // while p1 sits in the lobby
  await off;

  const order = [];
  p1.on('meeting:settings', (s) => order.push(['meeting:settings', s]));
  p1.on('meeting:admitted', () => order.push(['meeting:admitted']));
  const admitted = waitForEvent(p1, 'meeting:admitted');
  host.emit('lobby:admit', { userId: 'p1' });
  await admitted;
  assert.deepEqual(order, [
    ['meeting:settings', { admission: 'manual', screenSharePolicy: 'anyone', aiEnabled: false, aiNudges: false }],
    ['meeting:admitted'],
  ]);
});

// ── The chat history the AI reads ────────────────────────────────────────────

test('every chat line joins the history, and a history failure never blocks the chat', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { meetingId, history, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const first = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: '  Agenda: ship date  ' });
  await first;
  await settle(); // the line is added just after it is relayed
  assert.deepEqual(await history.recent(meetingId), [{ name: 'Hana Host', text: 'Agenda: ship date', ai: false }]);

  history.add = async () => {
    throw new Error('redis hiccup');
  };
  const second = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: 'Still delivered' });
  assert.equal((await second).text, 'Still delivered');
  await settle();
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.ok(logged.some((line) => /chat history failed: redis hiccup/.test(line)), logged.join('\n'));
});

test('End for all clears the history', async (t) => {
  const { meetingId, history, join } = await roomHarness(t);
  const host = await join('host');
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  const ended = waitForEvent(host, 'meeting:ended');
  host.emit('host:end-meeting');
  await ended;
  await settle();
  assert.deepEqual(await history.recent(meetingId), []);
});

test('a failing history clear is logged as such and never stops End for all', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { history, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  history.clear = async () => {
    throw new Error('redis hiccup');
  };
  const ended = Promise.all([host, p1].map((c) => waitForEvent(c, 'meeting:ended')));
  host.emit('host:end-meeting');
  await ended;
  await settle();
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.ok(logged.some((line) => /chat history clear failed: redis hiccup/.test(line)), logged.join('\n'));
  assert.ok(!logged.some((line) => /socket host:end-meeting failed/.test(line)), logged.join('\n'));
});

test('the last person leaving clears the history', async (t) => {
  const { meetingId, history, join } = await roomHarness(t);
  const host = await join('host');
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  const gone = waitForEvent(host, 'disconnect');
  host.emit('meeting:leave');
  await gone;
  await settle();
  assert.deepEqual(await history.recent(meetingId), []);
});

test("the sweep's ends clear the history too", async (t) => {
  const { db, meetingId, history, handlers } = await roomHarness(t);
  // Live in Postgres, held by no server: the sweep's Postgres pass ends it.
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [meetingId]);
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  await handlers.sweep();
  assert.deepEqual(await history.recent(meetingId), []);
});

test("the sweep's idle clear clears the history too", async (t) => {
  // An empty room is "idle" at once, instead of after the real minute.
  const decorateStore = (real) => ({ ...real, clearIfIdle: (code) => real.clearIfIdle(code, 0) });
  const { meetingId, store, history, handlers } = await roomHarness(t, { decorateStore });
  await store.initMeta(meetingId, { hostId: 'host', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 3, mode: 'standard' });
  await history.add(meetingId, { name: 'Hana Host', text: 'Bye' });
  await handlers.sweep();
  assert.equal(await store.getMeta(meetingId), null); // the idle clear ran, not some other path
  assert.deepEqual(await history.recent(meetingId), []);
});

// ── Ask AI ───────────────────────────────────────────────────────────────────

test("a seated person's question is posted as chat, then the answer streams to everyone", async (t) => {
  const { provider, ai } = await fakeAi(t, aiAnswer(['Ship ', 'on ', 'Friday.'], { gapMs: 150 }));
  const { join } = await roomHarness(t, { ai });
  const people = [await join('host'), await join('p1'), await join('p2')];
  const [, p1] = people;
  const chats = people.map((c) => collect(c, 'chat:message'));
  const heard = people.map(aiEvents);
  const done = Promise.all(people.map((c) => waitForEvent(c, 'ai:done')));
  p1.emit('ai:ask', { text: '  When do we ship?  ' });
  await done;

  for (const chat of chats) {
    assert.equal(chat.length, 1);
    assert.deepEqual({ ...chat[0], ts: 0 }, { userId: 'p1', name: 'Priya One', text: 'When do we ship?', toAi: true, ts: 0 });
  }
  for (const events of heard) {
    const [[first, start], ...rest] = events;
    assert.equal(first, 'ai:start');
    assert.deepEqual(start.askedBy, { userId: 'p1', name: 'Priya One' });
    assert.equal(typeof start.ts, 'number');
    const chunks = rest.filter(([event]) => event === 'ai:chunk').map(([, payload]) => payload);
    const [lastEvent, last] = rest.at(-1);
    assert.equal(lastEvent, 'ai:done');
    assert.equal(last.text, 'Ship on Friday.');
    assert.ok(chunks.length >= 2, 'pieces 150 ms apart go out as separate chunks');
    assert.equal(chunks.map((c) => c.delta).join(''), 'Ship on Friday.');
    for (const [, payload] of rest) assert.equal(payload.id, start.id);
  }
  assert.deepEqual(heard[0], heard[1]);
  assert.deepEqual(heard[1], heard[2]);
  assert.equal(provider.requests.length, 1);
});

test('pieces arriving together are batched into one chunk', async (t) => {
  const { ai } = await fakeAi(t, aiAnswer(['a', 'b', 'c', 'd', 'e']));
  const { join } = await roomHarness(t, { ai });
  const host = await join('host');
  const chunks = collect(host, 'ai:chunk');
  const done = waitForEvent(host, 'ai:done');
  host.emit('ai:ask', { text: 'Letters?' });
  assert.equal((await done).text, 'abcde');
  assert.ok(chunks.length <= 2, `${chunks.length} chunks`);
  assert.equal(chunks.map((c) => c.delta).join(''), 'abcde');
});

test('the AI gets the last 20 chat lines, answers included, then the question; both join the history', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { meetingId, history, join } = await roomHarness(t, { ai });
  const host = await join('host');
  for (let i = 1; i <= 24; i++) await history.add(meetingId, { name: 'Pablo Two', text: `line ${i}` });
  await history.add(meetingId, { name: 'Zylo AI', text: 'An earlier answer.', ai: true });
  const chat = waitForEvent(host, 'chat:message');
  host.emit('chat:message', { text: 'One more thing' });
  await chat;
  await settle(); // the line is added just after it is relayed

  const done = waitForEvent(host, 'ai:done');
  host.emit('ai:ask', { text: 'What did we decide?' });
  await done;
  const [system, user] = provider.requests[0].body.messages;
  assert.equal(system.role, 'system');
  const lines = user.content.split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines[0], 'Pablo Two: line 7');
  assert.deepEqual(lines.slice(-3), ['Zylo AI: An earlier answer.', 'Hana Host: One more thing', 'Hana Host: What did we decide?']);

  await settle(); // the answer is added just after ai:done
  assert.deepEqual((await history.recent(meetingId)).slice(-2), [
    { name: 'Hana Host', text: 'What did we decide?', ai: false },
    { name: 'Zylo AI', text: 'Hello there.', ai: true },
  ]);
});

test('the lobby, a replaced tab and a socket that never joined are ignored, silently', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { meetingId, store, connect, join } = await roomHarness(t, { ai, admission: 'manual' });
  const host = await join('host');
  const waiter = connect('p1');
  const waiting = waitForEvent(waiter, 'meeting:waiting');
  waiter.emit('meeting:join-request', { meetingId });
  await waiting;
  const ghost = connect('p2');
  await waitForEvent(ghost, 'connect');
  const chat = collect(host, 'chat:message');
  const heard = aiEvents(host);
  const errors = [host, waiter, ghost].map((c) => collect(c, 'ai:error'));

  waiter.emit('ai:ask', { text: 'from the lobby' });
  ghost.emit('ai:ask', { text: 'never joined' });
  await takeOverSeat(store, meetingId, 'host', 'host-second-tab');
  host.emit('ai:ask', { text: 'from the replaced tab' });
  await settle(150);

  assert.deepEqual(chat, []);
  assert.deepEqual(heard, []);
  for (const got of errors) assert.deepEqual(got, []);
  assert.equal(provider.requests.length, 0);
});

test('a translator convo ignores ai:ask, silently', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { join } = await roomHarness(t, { ai, mode: 'translator', maxParticipants: 2 });
  const host = await join('host');
  const chat = collect(host, 'chat:message');
  const errors = collect(host, 'ai:error');
  const heard = aiEvents(host);
  host.emit('ai:ask', { text: 'Translate this?' });
  await settle(150);
  assert.deepEqual([chat, errors, heard], [[], [], []]);
  assert.equal(provider.requests.length, 0);
});

test('with AI turned off the asker is told, nothing is posted and the provider is never called', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { join } = await roomHarness(t, { ai });
  const host = await join('host');
  const p1 = await join('p1');
  const off = waitForEvent(p1, 'meeting:settings');
  host.emit('host:set-ai', { enabled: false });
  await off;
  const hostChat = collect(host, 'chat:message');
  const hostErrors = collect(host, 'ai:error');
  const error = waitForEvent(p1, 'ai:error');
  p1.emit('ai:ask', { text: 'Anyone there?' });
  assert.deepEqual(await error, { reason: 'disabled' });
  await settle();
  assert.deepEqual(hostChat, []);
  assert.deepEqual(hostErrors, []);
  assert.equal(provider.requests.length, 0);
});

test('turning AI off lets an answer already streaming finish', async (t) => {
  const { ai } = await fakeAi(t, aiAnswer(['Still ', 'here.'], { gapMs: 150 }));
  const { join } = await roomHarness(t, { ai });
  const host = await join('host');
  const started = waitForEvent(host, 'ai:start');
  const done = waitForEvent(host, 'ai:done');
  host.emit('ai:ask', { text: 'Are you there?' });
  await started;
  host.emit('host:set-ai', { enabled: false });
  assert.equal((await done).text, 'Still here.');
});

test('without AI configured the asker is told, and nothing is posted or streamed', async (t) => {
  const { join } = await roomHarness(t); // no ai
  const host = await join('host');
  const p1 = await join('p1');
  const chat = collect(p1, 'chat:message');
  const heard = aiEvents(p1);
  const error = waitForEvent(host, 'ai:error');
  host.emit('ai:ask', { text: 'Hello AI?' });
  assert.deepEqual(await error, { reason: 'not_configured' });
  await settle();
  assert.deepEqual(chat, []);
  assert.deepEqual(heard, []);
});

test('a person asking too often is refused before any store read, and nothing is posted', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const limiter = refusingLimiter('aiUser');
  let reads = 0;
  const count = (fn) => async (...args) => {
    reads += 1;
    return fn(...args);
  };
  const decorateStore = (s) => ({ ...s, seatFor: count(s.seatFor), getMeta: count(s.getMeta) });
  const { join } = await roomHarness(t, { ai, limiter, decorateStore });
  const host = await join('host');
  const chat = collect(host, 'chat:message');
  await settle(); // the join's own broadcasts still read the store after meeting:admitted
  reads = 0;
  const refused = waitForEvent(host, 'rate-limited');
  host.emit('ai:ask', { text: 'Again?' });
  assert.deepEqual(await refused, { event: 'ai:ask' });
  await settle();
  assert.equal(reads, 0);
  assert.deepEqual(limiter.takes, [['aiUser', 'host']]);
  assert.deepEqual(chat, []);
  assert.equal(provider.requests.length, 0);
});

test('a meeting asking too often is refused after the other checks, and nothing is posted', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const limiter = refusingLimiter('aiRoom');
  const { meetingId, join } = await roomHarness(t, { ai, limiter });
  const host = await join('host');
  const chat = collect(host, 'chat:message');
  const refused = waitForEvent(host, 'rate-limited');
  host.emit('ai:ask', { text: 'Again?' });
  assert.deepEqual(await refused, { event: 'ai:ask' });
  await settle();
  assert.deepEqual(limiter.takes, [['aiUser', 'host'], ['aiRoom', meetingId]]);
  assert.deepEqual(chat, []);
  assert.equal(provider.requests.length, 0);
});

test('a provider error reaches everyone as ai:failed, is logged, and stays out of the history', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { ai } = await fakeAi(t, (res) => res.writeHead(500).end('upstream exploded'));
  const { meetingId, history, join } = await roomHarness(t, { ai });
  const host = await join('host');
  const p1 = await join('p1');
  const failed = Promise.all([host, p1].map((c) => waitForEvent(c, 'ai:failed')));
  const done = collect(p1, 'ai:done');
  p1.emit('ai:ask', { text: 'Will this work?' });
  const [forHost, forP1] = await failed;
  assert.deepEqual(forHost, forP1);
  assert.equal(forHost.message, "The AI couldn't answer. Try again.");
  await settle();
  assert.deepEqual(done, []);
  assert.deepEqual((await history.recent(meetingId)).map((entry) => entry.text), ['Will this work?']);
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.ok(logged.some((line) => /AI answer failed: AI provider answered 500/.test(line)), logged.join('\n'));
});

test('a provider that hangs fails the answer for everyone at the timeout', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { ai } = await fakeAi(t, () => {}, { timeoutMs: 300 });
  const { meetingId, history, join } = await roomHarness(t, { ai });
  const host = await join('host');
  const p1 = await join('p1');
  const failed = Promise.all([host, p1].map((c) => waitForEvent(c, 'ai:failed')));
  host.emit('ai:ask', { text: 'Hello?' });
  await failed;
  await settle();
  assert.deepEqual((await history.recent(meetingId)).map((entry) => entry.name), ['Hana Host']);
});
