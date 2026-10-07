const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { AccessToken } = require('livekit-server-sdk');
const { createApp } = require('../app');
const { createLivekit } = require('../lib/livekit');
const { createRoomStore } = require('../lib/roomStore');
const { listen, fakeAuth, setupTestRedis, seatInStore } = require('./helpers');

const API_KEY = 'devkey';
const API_SECRET = 'secret';
const MEETING_ID = 'web-hook-evt';

// The real createLivekit — so the signature check and evict are the real code —
// over a RoomServiceClient stand-in that records removals. db: null on purpose:
// the webhook must not depend on /api's guards.
async function start(t, { configured = true, store = null } = {}) {
  const removed = [];
  const rooms = { removeParticipant: async (room, identity) => { removed.push([room, identity]); } };
  const livekit = configured ? createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms }) : null;
  const server = await listen(createApp({ db: null, auth: fakeAuth, livekit, store }));
  t.after(() => server.close());
  return { server, removed };
}

// Signs a body the way livekit-server does: a JWT issued by the API key whose
// sha256 claim is the base64 SHA-256 of the exact body bytes.
async function sign(body, secret = API_SECRET) {
  const token = new AccessToken(API_KEY, secret);
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

// No x-test-user header, ever: a 200 here proves the route is not behind Clerk.
const post = (server, body, { authorization, type = 'application/webhook+json' } = {}) =>
  fetch(`${server.base}/livekit/webhook`, {
    method: 'POST',
    headers: { 'content-type': type, ...(authorization ? { authorization } : {}) },
    body,
  }).then((res) => res.status);

const event = (name, identity, room = MEETING_ID) =>
  JSON.stringify({ event: name, room: { name: room }, participant: { identity } });

test('an unsigned webhook is rejected and evicts nobody', async (t) => {
  const { server, removed } = await start(t);
  t.mock.method(console, 'error');
  const body = event('participant_joined', 'intruder');
  const status = await post(server, body);
  assert.equal(status, 401);
  assert.deepEqual(removed, []);
  // I4: a rejected webhook used to be silent — a key rotation or check bug would
  // switch off this line of defence with no signal. Now it logs.
  assert.equal(console.error.mock.callCount(), 1);
  assert.match(console.error.mock.calls[0].arguments[0], /livekit webhook rejected/);
});

test('a webhook signed with the wrong secret is rejected', async (t) => {
  const { server, removed } = await start(t);
  const body = event('participant_joined', 'intruder');
  const authorization = await sign(body, 'not-the-secret');
  const status = await post(server, body, { authorization });
  assert.equal(status, 401);
  assert.deepEqual(removed, []);
});

test('a webhook whose body changed after signing is rejected', async (t) => {
  const { server, removed } = await start(t);
  const signedBody = event('participant_joined', 'intruder');
  const authorization = await sign(signedBody);
  const sentBody = event('participant_joined', 'someone-else');
  const status = await post(server, sentBody, { authorization });
  assert.equal(status, 401);
  assert.deepEqual(removed, []);
});

test('someone joining LiveKit without a seat is evicted', async (t) => {
  const store = createRoomStore(await setupTestRedis(t), { serverId: 'test' });
  const { server, removed } = await start(t, { store });
  const body = event('participant_joined', 'intruder');
  const authorization = await sign(body);
  const status = await post(server, body, { authorization });
  assert.equal(status, 200);
  assert.deepEqual(removed, [[MEETING_ID, 'intruder']]);
});

test('a seat holder joining LiveKit is left alone', async (t) => {
  const store = createRoomStore(await setupTestRedis(t), { serverId: 'test' });
  const { server, removed } = await start(t, { store });
  await seatInStore(store, MEETING_ID, { userId: 'p1', socketId: 's1', name: 'Priya One' });
  const body = event('participant_joined', 'p1');
  const authorization = await sign(body);
  const status = await post(server, body, { authorization });
  assert.equal(status, 200);
  assert.deepEqual(removed, []);
});

test('other events and rooms that are not meetings are ignored', async (t) => {
  const { server, removed } = await start(t);
  const leftBody = event('participant_left', 'intruder');
  const leftAuth = await sign(leftBody);
  const leftStatus = await post(server, leftBody, { authorization: leftAuth });

  const nonMeetingBody = event('participant_joined', 'intruder', 'live-test-1-1');
  const nonMeetingAuth = await sign(nonMeetingBody);
  const nonMeetingStatus = await post(server, nonMeetingBody, { authorization: nonMeetingAuth });

  assert.equal(leftStatus, 200);
  assert.equal(nonMeetingStatus, 200);
  assert.deepEqual(removed, []);
});

test('a webhook sent as application/json still verifies', async (t) => {
  const { server, removed } = await start(t);
  const body = event('participant_joined', 'intruder');
  const authorization = await sign(body);
  const status = await post(server, body, { authorization, type: 'application/json' });
  assert.equal(status, 200);
  assert.deepEqual(removed, [[MEETING_ID, 'intruder']]);
});

test('there is no webhook route when LiveKit is not configured', async (t) => {
  const { server } = await start(t, { configured: false });
  const body = event('participant_joined', 'intruder');
  const status = await post(server, body);
  assert.equal(status, 404);
});
