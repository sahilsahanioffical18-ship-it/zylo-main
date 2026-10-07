const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAi, SYSTEM_PROMPT } = require('../lib/ai');
const { NUDGE_PROMPT } = require('../lib/nudge');
const { SOCKET_POLICIES } = require('../lib/rateLimit');
const { roomHarness, collect, settle, waitForEvent, takeOverSeat, startFakeAi, aiAnswer } = require('./helpers');

// A provider client pointed at a fake OpenAI-compatible server (helpers.js).
async function fakeAi(t, respond, options = {}) {
  const provider = await startFakeAi(t, respond);
  return { provider, ai: createAi({ baseUrl: provider.baseUrl, apiKey: 'test-key', model: 'test-model', ...options }) };
}

// Sends one chat line and waits until the room has it (the sender hears it back).
async function say(client, text) {
  const back = waitForEvent(client, 'chat:message');
  client.emit('chat:message', { text });
  await back;
}

// The meeting row with nudges on. Before the first join: that is when the room reads it.
const nudgesOnInDb = (db, meetingId) => db.query('UPDATE meetings SET ai_nudges = true WHERE id = $1', [meetingId]);

// Every quiet clock pushed a minute and a second into the past: a test can't wait a real minute.
async function quietForAMinute(store, meetingId) {
  const longAgo = Date.now() - 61_000;
  for (const field of ['nudgesOnAt', 'lastVoiceAt', 'lastChatAt']) await store.setMetaField(meetingId, field, longAgo);
}

// Wraps a fake provider's respond: `asked` settles when a request arrives. With hold, the
// answer waits for release(), so a test can act while the AI is "thinking".
function watchProvider(respond, { hold = false } = {}) {
  let arrived;
  let release;
  const asked = new Promise((resolve) => {
    arrived = resolve;
  });
  const released = hold ? new Promise((resolve) => (release = resolve)) : null;
  return {
    asked,
    release: () => release(),
    respond: async (res, request) => {
      arrived();
      await released;
      await respond(res, request);
    },
  };
}

// Refuses one policy and records every take.
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

// ── The host's "AI nudges" setting ───────────────────────────────────────────

test('host:set-nudges turns nudges on and off: saved in the store and Postgres, told to the room', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const settings = collect(p1, 'meeting:settings');
  assert.equal((await store.getMeta(meetingId)).aiNudges, false); // off by default

  const before = Date.now();
  host.emit('host:set-nudges', { enabled: true });
  await settle();
  assert.deepEqual(settings, [{ admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: true, aiNudges: true }]);
  const meta = await store.getMeta(meetingId);
  assert.equal(meta.aiNudges, true);
  assert.ok(meta.nudgesOnAt >= before && meta.nudgesOnAt <= Date.now(), `nudgesOnAt ${meta.nudgesOnAt}`); // the quiet clock restarts
  let { rows } = await db.query('SELECT ai_nudges FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ai_nudges, true);

  host.emit('host:set-nudges', { enabled: false });
  await settle();
  assert.deepEqual(settings.at(-1), { admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: true, aiNudges: false });
  assert.equal((await store.getMeta(meetingId)).aiNudges, false);
  ({ rows } = await db.query('SELECT ai_nudges FROM meetings WHERE id = $1', [meetingId]));
  assert.equal(rows[0].ai_nudges, false);
});

test('host:set-nudges is host-only and ignores anything but a boolean', async (t) => {
  const { db, meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  const p1 = await join('p1');
  const settings = collect(host, 'meeting:settings');
  const forbidden = waitForEvent(p1, 'error:forbidden');
  p1.emit('host:set-nudges', { enabled: true });
  await forbidden;
  host.emit('host:set-nudges', { enabled: 'true' });
  host.emit('host:set-nudges', {});
  await settle();
  assert.equal(settings.length, 0);
  assert.equal((await store.getMeta(meetingId)).aiNudges, false);
  const { rows } = await db.query('SELECT ai_nudges FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].ai_nudges, false);
});

test('host:set-nudges is ignored in a translator convo', async (t) => {
  const { meetingId, store, join } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });
  const host = await join('host');
  const settings = collect(host, 'meeting:settings');
  host.emit('host:set-nudges', { enabled: true });
  await settle();
  assert.equal(settings.length, 0);
  assert.equal((await store.getMeta(meetingId)).aiNudges, false);
});

test('a meeting saved with nudges on starts with them on and its quiet clock running, and every settings message says so', async (t) => {
  const { db, meetingId, store, connect } = await roomHarness(t);
  await db.query('UPDATE meetings SET ai_nudges = true WHERE id = $1', [meetingId]);
  const before = Date.now();
  const host = connect('host');
  const settings = collect(host, 'meeting:settings');
  const admitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await admitted;
  const meta = await store.getMeta(meetingId);
  assert.equal(meta.aiNudges, true);
  assert.ok(meta.nudgesOnAt >= before, `nudgesOnAt ${meta.nudgesOnAt}`);
  host.emit('host:set-screen-policy', { policy: 'host_only' });
  await settle();
  assert.deepEqual(settings, [
    { admission: 'auto', screenSharePolicy: 'anyone', aiEnabled: true, aiNudges: true }, // sent on admission
    { admission: 'auto', screenSharePolicy: 'host_only', aiEnabled: true, aiNudges: true },
  ]);
});

test('host:set-ai turning AI back on restarts the quiet clock, since that turns nudges back on too', async (t) => {
  const { meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  host.emit('host:set-nudges', { enabled: true });
  await settle();
  const stale = Date.now() - 600_000;
  await store.setMetaField(meetingId, 'nudgesOnAt', stale); // quiet for ten minutes, nudges on

  host.emit('host:set-ai', { enabled: false }); // browsers stop reporting speech while AI is off
  await settle();
  assert.equal((await store.getMeta(meetingId)).nudgesOnAt, stale, 'turning AI off leaves the clock alone');

  const before = Date.now();
  host.emit('host:set-ai', { enabled: true });
  await settle();
  const meta = await store.getMeta(meetingId);
  assert.equal(meta.aiEnabled, true);
  assert.equal(meta.aiNudges, true);
  assert.ok(meta.nudgesOnAt >= before && meta.nudgesOnAt <= Date.now(), `nudgesOnAt ${meta.nudgesOnAt}`);
});

// ── The signals: speech and chat restart the quiet clock ─────────────────────

test('voice:activity from a seated person stamps lastVoiceAt and starts a new quiet stretch', async (t) => {
  const { meetingId, store, join } = await roomHarness(t);
  const host = await join('host');
  await store.setMetaField(meetingId, 'quietNudged', '1');
  const before = Date.now();
  host.emit('voice:activity');
  await settle();
  const meta = await store.getMeta(meetingId);
  assert.ok(meta.lastVoiceAt >= before && meta.lastVoiceAt <= Date.now(), `lastVoiceAt ${meta.lastVoiceAt}`);
  assert.equal(meta.quietNudged, false);
});

test('voice:activity from the lobby, a replaced tab or a socket that never joined does nothing', async (t) => {
  const { meetingId, store, connect, join } = await roomHarness(t, { admission: 'manual' });
  const host = await join('host');
  const waiter = connect('p1');
  const waiting = waitForEvent(waiter, 'meeting:waiting');
  waiter.emit('meeting:join-request', { meetingId });
  await waiting;
  const ghost = connect('p2');
  await waitForEvent(ghost, 'connect');
  await takeOverSeat(store, meetingId, 'host', 'host-second-tab');
  for (const socket of [waiter, ghost, host]) socket.emit('voice:activity');
  await settle(150);
  assert.equal((await store.getMeta(meetingId)).lastVoiceAt, 0);
});

test('voice:activity is ignored in a translator convo', async (t) => {
  const { meetingId, store, join } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });
  const host = await join('host');
  host.emit('voice:activity');
  await settle();
  assert.equal((await store.getMeta(meetingId)).lastVoiceAt, 0);
});

test('voice:activity past its per-socket limit is dropped without a notice', async (t) => {
  let touches = 0;
  const decorateStore = (s) => ({
    ...s,
    touch: async (...args) => {
      touches += 1;
      return s.touch(...args);
    },
  });
  const { join } = await roomHarness(t, { decorateStore });
  const host = await join('host');
  const refused = collect(host, 'rate-limited');
  const { burst } = SOCKET_POLICIES['voice:activity'];
  for (let i = 0; i < burst + 3; i++) host.emit('voice:activity');
  await settle(150);
  assert.equal(touches, burst);
  assert.deepEqual(refused, []);
});

test("a person's chat line stamps lastChatAt and starts a new quiet stretch, a question to the AI too; an answer doesn't", async (t) => {
  const { ai } = await fakeAi(t, aiAnswer(['Friday ', 'works.'], { gapMs: 150 }));
  const { meetingId, store, join } = await roomHarness(t, { ai });
  const host = await join('host');
  await store.setMetaField(meetingId, 'quietNudged', '1');
  const before = Date.now();
  await say(host, 'Agenda: the launch date');
  await settle();
  let meta = await store.getMeta(meetingId);
  assert.ok(meta.lastChatAt >= before, `lastChatAt ${meta.lastChatAt}`);
  assert.equal(meta.quietNudged, false);

  await store.setMetaField(meetingId, 'quietNudged', '1');
  const asked = Date.now();
  const started = waitForEvent(host, 'ai:start');
  const done = waitForEvent(host, 'ai:done');
  host.emit('ai:ask', { text: 'Which day?' });
  await started; // the question was relayed and stamped before the answer started
  meta = await store.getMeta(meetingId);
  assert.ok(meta.lastChatAt >= asked, `lastChatAt ${meta.lastChatAt}`);
  assert.equal(meta.quietNudged, false);
  await store.setMetaField(meetingId, 'lastChatAt', 1);
  await done;
  await settle(); // the answer joins the history just after ai:done
  assert.equal((await store.getMeta(meetingId)).lastChatAt, 1, 'an answer is not activity');
});

test('a failing signal write is logged once and never blocks the chat', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const decorateStore = (s) => ({
    ...s,
    touch: async () => {
      throw new Error('redis hiccup');
    },
  });
  const { join } = await roomHarness(t, { decorateStore });
  const host = await join('host');
  const p1 = await join('p1');
  const got = collect(p1, 'chat:message');
  await say(host, 'one');
  await say(host, 'two');
  await settle();
  assert.deepEqual(got.map((m) => m.text), ['one', 'two']);
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.equal(logged.filter((line) => /nudge signal failed: redis hiccup/.test(line)).length, 1, logged.join('\n'));
  assert.ok(!logged.some((line) => /socket chat:message failed/.test(line)), logged.join('\n'));
});

// ── Chat triggers ────────────────────────────────────────────────────────────

test('“I’m stuck” brings everyone one stuck nudge: the AI is told why and given the chat, and the nudge is remembered', async (t) => {
  const { provider, ai } = await fakeAi(t, aiAnswer(['Try splitting ', 'the API task.']));
  const { db, meetingId, history, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const people = [await join('host'), await join('p1'), await join('p2')];
  const heard = people.map((c) => collect(c, 'ai:nudge'));
  const arrived = Promise.all(people.map((c) => waitForEvent(c, 'ai:nudge')));
  await say(people[1], 'I’m stuck on the API');
  const [nudge] = await arrived;
  assert.deepEqual({ ...nudge, id: 'id', ts: 0 }, { id: 'id', text: 'Try splitting the API task.', reason: 'stuck', ts: 0 });
  assert.equal(typeof nudge.id, 'string');
  assert.equal(typeof nudge.ts, 'number');
  await settle(150);
  for (const got of heard) assert.deepEqual(got, [nudge]);
  assert.equal(provider.requests.length, 1);
  const { body } = provider.requests[0];
  assert.equal(body.max_tokens, 200);
  assert.deepEqual(body.messages, [
    { role: 'system', content: NUDGE_PROMPT('stuck') },
    { role: 'user', content: 'Priya One: I’m stuck on the API' },
  ]);
  assert.deepEqual((await history.recent(meetingId)).at(-1), { name: 'Zylo AI', text: 'Try splitting the API task.', ai: true });
});

test('three lines going in circles bring a circles nudge', async (t) => {
  const { provider, ai } = await fakeAi(t, aiAnswer(['You agree on Friday; is anything still open?']));
  const { db, meetingId, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const p1 = await join('p1');
  const nudge = waitForEvent(p1, 'ai:nudge');
  await say(host, 'We ship it Friday, now!');
  await say(p1, 'we ship it friday then');
  await settle();
  assert.equal(provider.requests.length, 0, 'two lines are not a circle yet');
  await say(host, 'We ship it Friday later?');
  assert.equal((await nudge).reason, 'circles');
  assert.equal(provider.requests[0].body.messages[0].content, NUDGE_PROMPT('circles'));
});

test('a line that is both stuck and circling is a stuck nudge', async (t) => {
  const { ai } = await fakeAi(t);
  const { db, meetingId, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudge = waitForEvent(host, 'ai:nudge');
  await say(host, 'we ship it on friday');
  await say(host, 'we ship it on friday');
  await settle(); // both checked before the third arrives: two lines are no circle
  await say(host, 'not sure we ship it on friday');
  assert.equal((await nudge).reason, 'stuck');
});

test('the AI answering NO_NUDGE posts nothing and remembers nothing', async (t) => {
  const watch = watchProvider(aiAnswer(['NO_', 'NUDGE']));
  const { ai } = await fakeAi(t, watch.respond);
  const { db, meetingId, history, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudges = collect(host, 'ai:nudge');
  await say(host, 'not sure');
  await watch.asked;
  await settle(150);
  assert.deepEqual(nudges, []);
  assert.deepEqual((await history.recent(meetingId)).map((entry) => entry.text), ['not sure']);
});

test('a second trigger inside the 90 s cooldown never reaches the provider', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { db, meetingId, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudges = collect(host, 'ai:nudge');
  const first = waitForEvent(host, 'ai:nudge');
  await say(host, "I'm stuck");
  await first;
  await say(host, 'still no idea');
  await settle(150);
  assert.equal(provider.requests.length, 1);
  assert.equal(nudges.length, 1);
});

test('the deployment-wide budget saying no means no provider call', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const limiter = refusingLimiter('aiNudgeAll');
  const { db, meetingId, join } = await roomHarness(t, { ai, limiter });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  await say(host, "I'm stuck");
  await settle(150);
  assert.deepEqual(limiter.takes, [['aiNudgeAll', 'all']]);
  assert.equal(provider.requests.length, 0);
});

test('nudges are off by default, and stay silent while AI in chat is off', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { join } = await roomHarness(t, { ai });
  const host = await join('host');
  await say(host, "I'm stuck");
  await settle(150);
  assert.equal(provider.requests.length, 0, 'off by default');

  const on = waitForEvent(host, 'meeting:settings');
  host.emit('host:set-nudges', { enabled: true });
  await on;
  const aiOff = waitForEvent(host, 'meeting:settings');
  host.emit('host:set-ai', { enabled: false });
  await aiOff;
  await say(host, 'no idea');
  await settle(150);
  assert.equal(provider.requests.length, 0, 'AI in chat is off');
});

test('a server without AI runs no checks', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { db, meetingId, store, handlers, join } = await roomHarness(t); // no ai
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const p1 = await join('p1');
  const nudges = collect(p1, 'ai:nudge');
  await say(host, "I'm stuck");
  await say(p1, 'no idea either');
  await quietForAMinute(store, meetingId);
  await handlers.sweep();
  await settle(150);
  assert.deepEqual(nudges, []);
  assert.deepEqual(errors.mock.calls, []);
});

test('a line sent with Ask AI never triggers a nudge', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { db, meetingId, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudges = collect(host, 'ai:nudge');
  const done = waitForEvent(host, 'ai:done');
  host.emit('ai:ask', { text: "I'm stuck: what's next?" });
  await done;
  await settle(150);
  assert.equal(provider.requests.length, 1, 'the answer only');
  assert.equal(provider.requests[0].body.messages[0].content, SYSTEM_PROMPT);
  assert.deepEqual(nudges, []);
});

// ── The quiet room ───────────────────────────────────────────────────────────

test('the quiet sweep: one nudge per quiet stretch, another only after new activity and a new quiet minute', async (t) => {
  const { provider, ai } = await fakeAi(t, aiAnswer(['Where did you land on the date?']));
  // No 90 s cooldown here: this test is about quiet stretches, not the claim.
  const decorateStore = (s) => ({ ...s, claimNudge: async () => true });
  const { db, meetingId, store, handlers, join } = await roomHarness(t, { ai, decorateStore });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const p1 = await join('p1');
  await say(host, 'Agenda: the launch date');
  await say(p1, 'Friday or Monday');
  await settle(); // the lines' own checks and signal writes land
  const nudges = collect(p1, 'ai:nudge');

  await quietForAMinute(store, meetingId);
  const first = waitForEvent(p1, 'ai:nudge');
  await handlers.sweep();
  assert.equal((await first).reason, 'quiet');
  assert.equal((await store.getMeta(meetingId)).quietNudged, true);

  await quietForAMinute(store, meetingId); // still the same quiet stretch
  await handlers.sweep();
  await settle(150);
  assert.equal(provider.requests.length, 1, 'one nudge per quiet stretch');

  host.emit('voice:activity'); // someone spoke: a new stretch starts...
  await settle();
  assert.equal((await store.getMeta(meetingId)).quietNudged, false);
  await handlers.sweep();
  await settle(150);
  assert.equal(provider.requests.length, 1, '...but it has to last a minute first');

  await quietForAMinute(store, meetingId);
  const second = waitForEvent(p1, 'ai:nudge');
  await handlers.sweep();
  assert.equal((await second).reason, 'quiet');
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1].body.messages[0].content, NUDGE_PROMPT('quiet'));
  assert.equal(nudges.length, 2);
});

test('the quiet sweep needs two people seated and two lines from people', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { db, meetingId, store, history, handlers, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  await history.add(meetingId, { name: 'Hana Host', text: 'Agenda: the launch date' });
  await history.add(meetingId, { name: 'Hana Host', text: 'Anyone here yet' });
  await quietForAMinute(store, meetingId);
  await handlers.sweep();
  await settle(150);
  assert.equal(provider.requests.length, 0, 'one person seated');

  await join('p1');
  await history.clear(meetingId);
  await history.add(meetingId, { name: 'Hana Host', text: 'Agenda: the launch date' });
  await history.add(meetingId, { name: 'Zylo AI', text: 'Friday works.', ai: true });
  await handlers.sweep();
  await settle(150);
  assert.equal(provider.requests.length, 0, "one line from a person: the AI's own don't count");

  await history.add(meetingId, { name: 'Priya One', text: 'Friday or Monday' });
  const nudge = waitForEvent(host, 'ai:nudge');
  await handlers.sweep();
  assert.equal((await nudge).reason, 'quiet');
});

// ── Never a fake nudge ───────────────────────────────────────────────────────

test('a provider error posts nothing and is logged on the server', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const watch = watchProvider((res) => res.writeHead(500).end('upstream exploded'));
  const { ai } = await fakeAi(t, watch.respond);
  const { db, meetingId, history, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudges = collect(host, 'ai:nudge');
  await say(host, 'idk');
  await watch.asked;
  await settle(150);
  assert.deepEqual(nudges, []);
  assert.deepEqual((await history.recent(meetingId)).map((entry) => entry.ai), [false]);
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.ok(logged.some((line) => /AI nudge failed: AI provider answered 500/.test(line)), logged.join('\n'));
});

test('turning nudges off while the AI is thinking drops the nudge', async (t) => {
  const watch = watchProvider(aiAnswer(['Too late.']), { hold: true });
  const { ai } = await fakeAi(t, watch.respond);
  const { db, meetingId, history, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudges = collect(host, 'ai:nudge');
  await say(host, 'idk');
  await watch.asked;
  const off = waitForEvent(host, 'meeting:settings');
  host.emit('host:set-nudges', { enabled: false });
  await off;
  watch.release();
  await settle(150);
  assert.deepEqual(nudges, []);
  assert.deepEqual((await history.recent(meetingId)).map((entry) => entry.ai), [false]);
});

test('a Translator Convo never runs a check', async (t) => {
  const { provider, ai } = await fakeAi(t);
  const { db, meetingId, store, handlers, join } = await roomHarness(t, { ai, mode: 'translator', maxParticipants: 2 });
  await nudgesOnInDb(db, meetingId); // only by hand: the host can't switch them on here
  const host = await join('host');
  const p1 = await join('p1');
  await say(host, "I'm stuck");
  await say(p1, 'no idea');
  await quietForAMinute(store, meetingId);
  await handlers.sweep();
  await settle(150);
  assert.equal(provider.requests.length, 0);
});

test('shutting down aborts a nudge the AI is still thinking about', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const watch = watchProvider(() => {}); // never answers
  const { ai } = await fakeAi(t, watch.respond);
  const { db, meetingId, handlers, join } = await roomHarness(t, { ai });
  await nudgesOnInDb(db, meetingId);
  const host = await join('host');
  const nudges = collect(host, 'ai:nudge');
  await say(host, "I'm stuck");
  await watch.asked;
  handlers.stop();
  await settle(150);
  assert.deepEqual(nudges, []);
  const logged = errors.mock.calls.map((call) => call.arguments.join(' '));
  assert.ok(logged.some((line) => /AI nudge failed: .*abort/i.test(line)), logged.join('\n'));
});
