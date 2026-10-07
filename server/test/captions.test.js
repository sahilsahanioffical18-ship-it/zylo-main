const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SOCKET_POLICIES } = require('../lib/rateLimit');
const { roomHarness, waitForEvent, collect, settle, insertMeeting, connectClient, takeOverSeat } = require('./helpers');

const caption = (overrides = {}) => ({ id: 'cap-1', text: 'hello there', lang: 'hi', final: true, ...overrides });

test("A's caption reaches B with userId/name from A's seat and a ts; A gets nothing back", async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId, lang: 'ru' });
  await p1Admitted;

  const hostCaptions = collect(host, 'convo:caption');
  const p1Captions = collect(p1, 'convo:caption');

  host.emit('convo:caption', caption());
  await settle();

  assert.equal(hostCaptions.length, 0); // A never gets its own caption back
  assert.equal(p1Captions.length, 1);
  assert.equal(p1Captions[0].userId, 'host');
  assert.equal(p1Captions[0].name, 'Hana Host');
  assert.equal(p1Captions[0].text, 'hello there');
  assert.equal(p1Captions[0].lang, 'hi');
  assert.equal(p1Captions[0].final, true);
  assert.equal(typeof p1Captions[0].ts, 'number');
});

test('a forged userId/name in the payload is ignored — identity comes from the seat', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const hostCaptions = collect(host, 'convo:caption');
  p1.emit('convo:caption', caption({ userId: 'host', name: 'Impostor' }));
  await settle();

  assert.equal(hostCaptions.length, 1);
  assert.equal(hostCaptions[0].userId, 'p1');
  assert.equal(hostCaptions[0].name, 'Priya One');
});

test('the same event in a standard meeting reaches nobody', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { maxParticipants: 3 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const p1Captions = collect(p1, 'convo:caption');
  host.emit('convo:caption', caption());
  await settle();

  assert.equal(p1Captions.length, 0);
});

test('a waiting (lobby) user cannot send a caption', async (t) => {
  const { meetingId, connect } = await roomHarness(t, {
    mode: 'translator',
    maxParticipants: 2,
    admission: 'manual',
  });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const waiting = waitForEvent(p1, 'meeting:waiting');
  p1.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await waiting;

  const hostCaptions = collect(host, 'convo:caption');
  p1.emit('convo:caption', caption());
  await settle();

  assert.equal(hostCaptions.length, 0);
});

test('a replaced tab cannot send a caption', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const first = connect('p1');
  const firstAdmitted = waitForEvent(first, 'meeting:admitted');
  first.emit('meeting:join-request', { meetingId });
  await firstAdmitted;

  const second = connect('p1');
  const replaced = waitForEvent(first, 'meeting:replaced');
  const secondAdmitted = waitForEvent(second, 'meeting:admitted');
  second.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, secondAdmitted]);

  const hostCaptions = collect(host, 'convo:caption');
  first.emit('convo:caption', caption());
  await settle();
  assert.equal(hostCaptions.length, 0);

  second.emit('convo:caption', caption());
  await settle();
  assert.equal(hostCaptions.length, 1);
});

// Pins the seat.socketId !== socket.id check by itself, the same technique
// translator.test.js and room.test.js use for convo:set-lang / chat:message: the
// seat is taken over in the store, bypassing the join handler, so p1's real socket
// keeps its meetingId while the seat has already moved on.
test('a socket the seat no longer points at cannot send a caption', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await p1Admitted;

  await takeOverSeat(store, meetingId, 'p1', 'synthetic-other-tab');
  assert.equal((await store.seatFor(meetingId, 'p1')).socketId, 'synthetic-other-tab');

  const hostCaptions = collect(host, 'convo:caption');
  p1.emit('convo:caption', caption());
  await settle();
  assert.equal(hostCaptions.length, 0);
});

test('a socket that never joined a meeting cannot send a caption', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const ghost = connect('ghost');
  await waitForEvent(ghost, 'connect');

  const hostCaptions = collect(host, 'convo:caption');
  ghost.emit('convo:caption', caption());
  await settle();
  assert.equal(hostCaptions.length, 0);
});

test('an invalid payload reaches nobody, with no error:forbidden and no meeting:denied', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const p1Captions = collect(p1, 'convo:caption');
  const forbidden = collect(host, 'error:forbidden');
  const denied = collect(host, 'meeting:denied');

  host.emit('convo:caption', {});
  host.emit('convo:caption', { ...caption(), id: 'BAD ID' });
  host.emit('convo:caption', { ...caption(), text: '' });
  host.emit('convo:caption', { ...caption(), lang: 'xx' });
  host.emit('convo:caption', { ...caption(), final: 'true' });
  host.emit('convo:caption', 'not an object');
  await settle();

  assert.equal(p1Captions.length, 0);
  assert.equal(forbidden.length, 0);
  assert.equal(denied.length, 0);
});

test('an invalid translation attachment is dropped, but the caption itself is kept', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const p1Captions = collect(p1, 'convo:caption');
  host.emit('convo:caption', caption({ translation: { lang: 'xx-bad', text: 'nope' } }));
  await settle();

  assert.equal(p1Captions.length, 1);
  assert.equal(p1Captions[0].text, 'hello there');
  assert.equal(p1Captions[0].translation, undefined);
});

test('a valid translation attachment is relayed, trimmed', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const p1Captions = collect(p1, 'convo:caption');
  host.emit('convo:caption', caption({ translation: { lang: 'ru', text: '  привет  ' } }));
  await settle();

  assert.deepEqual(p1Captions[0].translation, { lang: 'ru', text: 'привет' });
});

// Deterministic by construction: all 30 emits fire synchronously in one tick,
// before any timer (including the rate limiter's own elapsed-time math, which
// depends on Date.now() ticking forward — nothing here awaits between emits)
// gets a chance to hand back tokens. So this isn't "usually 12", it's exactly
// 12 every run: the burst, no more, no less.
test('rate limit end to end: 30 captions in one tick, B receives exactly the burst of 12', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const p1Captions = collect(p1, 'convo:caption');
  for (let i = 0; i < 30; i++) {
    host.emit('convo:caption', caption({ id: `cap-${i}` }));
  }
  await settle();

  assert.equal(p1Captions.length, 12);
});

test('no caption leak across meetings', async (t) => {
  const { db, meetingId, connect, server } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });
  const OTHER_MEETING_ID = 'oth-erme-eti';
  await insertMeeting(db, { id: OTHER_MEETING_ID, hostId: 'p2', mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const other = connectClient(server.url, 'p2');
  t.after(() => other.disconnect());
  const otherAdmitted = waitForEvent(other, 'meeting:admitted');
  other.emit('meeting:join-request', { meetingId: OTHER_MEETING_ID });
  await otherAdmitted;

  const otherCaptions = collect(other, 'convo:caption');
  host.emit('convo:caption', caption());
  await settle();

  assert.equal(otherCaptions.length, 0);
});

// Captions are the busiest event in Zylo, and the room state lives in the shared Redis:
// a socket that may not caption must stop costing it a read per caption once its bucket
// is empty, so the limit has to come before any store read.
test('a flood of captions from someone who may not caption stops reaching the store at the burst', async (t) => {
  let seatForCalls = 0;
  const decorateStore = (real) => ({
    ...real,
    seatFor: (...args) => {
      seatForCalls++;
      return real.seatFor(...args);
    },
  });
  const { meetingId, connect } = await roomHarness(t, { decorateStore }); // a standard meeting: nobody may caption

  const host = connect('host');
  const admitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await admitted;
  await settle();

  const { burst } = SOCKET_POLICIES['convo:caption'];
  seatForCalls = 0;
  for (let i = 0; i < burst + 20; i++) host.emit('convo:caption', caption({ id: `cap-${i}` }));
  await settle(200);

  assert.ok(seatForCalls > 0, 'the store is being counted');
  assert.ok(seatForCalls <= burst, `${seatForCalls} store reads for ${burst + 20} captions`);
});
