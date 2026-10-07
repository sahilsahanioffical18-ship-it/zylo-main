const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roomHarness, waitForEvent, collect, settle, takeOverSeat } = require('./helpers');

// Standard meetings still queue when full — this is the existing test at
// room.test.js's "auto mode: an explicit leave admits the waiting user"
// (maxParticipants: 2, the default mode 'standard'). Nothing here duplicates
// it; it keeps passing unchanged because insertMeeting/startRoom default
// mode to 'standard'.

test('a full translator meeting denies a 3rd person instead of queuing', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId });
  await p1Admitted;

  const p2 = connect('p2');
  const denied = waitForEvent(p2, 'meeting:denied');
  const waiting = collect(p2, 'meeting:waiting');
  p2.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'full' });
  await settle();
  assert.equal(waiting.length, 0);
  assert.equal(await store.hasSeat(meetingId, 'p2'), false);
});

test('a reconnecting seated guest is admitted even though the translator meeting is full', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1a = connect('p1');
  const p1aAdmitted = waitForEvent(p1a, 'meeting:admitted');
  p1a.emit('meeting:join-request', { meetingId });
  await p1aAdmitted;

  // p1 reconnects on a new socket while still seated: the room is full (host +
  // p1), but this is the replace path, not a new seat, so it must be admitted.
  const p1b = connect('p1');
  const replaced = waitForEvent(p1a, 'meeting:replaced');
  const p1bAdmitted = waitForEvent(p1b, 'meeting:admitted');
  p1b.emit('meeting:join-request', { meetingId });
  await Promise.all([replaced, p1bAdmitted]);
  assert.equal((await store.listSeats(meetingId)).length, 2);
});

test('presence carries lang for translator seats', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'ru' });
  await hostAdmitted;

  const presence = waitForEvent(host, 'room:presence');
  const p1 = connect('p1');
  const p1Admitted = waitForEvent(p1, 'meeting:admitted');
  p1.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await p1Admitted;
  const { people } = await presence;
  const byId = Object.fromEntries(people.map((p) => [p.userId, p.lang]));
  assert.equal(byId.host, 'ru');
  assert.equal(byId.p1, 'hi');
});

test('lang is always null in a standard meeting, even when the client sends one', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { maxParticipants: 3 });

  const host = connect('host');
  const presence = waitForEvent(host, 'room:presence');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'ru' });
  await hostAdmitted;
  const { people } = await presence;
  assert.equal(people.find((p) => p.userId === 'host').lang, null);
});

test('an invalid lang at join ends up null', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const presence = waitForEvent(host, 'room:presence');
  const admitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'xx-not-a-lang' });
  await admitted;
  const { people } = await presence;
  assert.equal(people[0].lang, null);
});

test('convo:set-lang updates the seat and broadcasts presence', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await hostAdmitted;

  const presence = waitForEvent(host, 'room:presence');
  host.emit('convo:set-lang', { lang: 'ru' });
  const { people } = await presence;
  assert.equal(people.find((p) => p.userId === 'host').lang, 'ru');
  assert.equal((await store.seatFor(meetingId, 'host')).lang, 'ru');
});

test('convo:set-lang is ignored from a standard meeting', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { maxParticipants: 3 });

  const host = connect('host');
  const admitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await admitted;

  const presence = collect(host, 'room:presence');
  host.emit('convo:set-lang', { lang: 'ru' });
  await settle();
  assert.equal(presence.length, 0);
  assert.equal((await store.seatFor(meetingId, 'host')).lang, null);
});

test('convo:set-lang is ignored from the lobby', async (t) => {
  const { meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2, admission: 'manual' });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await hostAdmitted;

  const p1 = connect('p1');
  const waiting = waitForEvent(p1, 'meeting:waiting');
  p1.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await waiting;

  const presence = collect(host, 'room:presence');
  p1.emit('convo:set-lang', { lang: 'ru' });
  await settle();
  assert.equal(presence.length, 0);
});

test('convo:set-lang is ignored from a replaced or stale socket', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await hostAdmitted;

  const p1a = connect('p1');
  const p1aAdmitted = waitForEvent(p1a, 'meeting:admitted');
  p1a.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await p1aAdmitted;

  const p1b = connect('p1');
  const replaced = waitForEvent(p1a, 'meeting:replaced');
  const p1bAdmitted = waitForEvent(p1b, 'meeting:admitted');
  p1b.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await Promise.all([replaced, p1bAdmitted]);
  // p1b's own join broadcasts its own presence update over host's socket too —
  // a race against 'meeting:replaced'/'meeting:admitted' on the OTHER two
  // sockets, since Socket.IO only orders events within one connection. Drain it
  // before collecting, so the collector below can't catch this stale one.
  await settle();

  const presence = collect(host, 'room:presence');
  p1a.emit('convo:set-lang', { lang: 'ru' }); // stale: the seat now points at p1b
  await settle();
  assert.equal(presence.length, 0);
  assert.equal((await store.seatFor(meetingId, 'p1')).lang, 'hi');
});

// Pins the seat.socketId !== socket.id check by itself. A replaced tab keeps its
// socket.data.meetingId in every case now (it may live on another server), so the
// test above already exercises this line; this one takes the seat over directly in
// the store, bypassing the join handler — the same technique room.test.js uses to
// pin the identical guard on chat:message.
test('convo:set-lang from a socket the seat no longer points at is ignored', async (t) => {
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
  await settle(); // drain p1's own join-triggered presence broadcast first

  const presence = collect(host, 'room:presence');
  p1.emit('convo:set-lang', { lang: 'ru' }); // real socket, but the seat moved
  await settle();
  assert.equal(presence.length, 0);
  assert.equal((await store.seatFor(meetingId, 'p1')).lang, 'hi');
});

test('convo:set-lang ignores an invalid lang', async (t) => {
  const { meetingId, connect, store } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const hostAdmitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId, lang: 'hi' });
  await hostAdmitted;

  const presence = collect(host, 'room:presence');
  host.emit('convo:set-lang', { lang: 'xx' });
  await settle();
  assert.equal(presence.length, 0);
  assert.equal((await store.seatFor(meetingId, 'host')).lang, 'hi');
});

test('host:set-admission is a no-op in translator meetings', async (t) => {
  const { db, meetingId, connect } = await roomHarness(t, { mode: 'translator', maxParticipants: 2 });

  const host = connect('host');
  const admitted = waitForEvent(host, 'meeting:admitted');
  host.emit('meeting:join-request', { meetingId });
  await admitted;

  const settings = collect(host, 'meeting:settings');
  host.emit('host:set-admission', { mode: 'manual' });
  await settle();
  assert.equal(settings.length, 0);
  const { rows } = await db.query('SELECT admission FROM meetings WHERE id = $1', [meetingId]);
  assert.equal(rows[0].admission, 'auto');
});
