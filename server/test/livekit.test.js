const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TokenVerifier, TrackSource } = require('livekit-server-sdk');
const { createLivekit } = require('../lib/livekit');
const { createApp } = require('../app');
const { createRoomStore } = require('../lib/roomStore');
const {
  listen,
  fakeAuth,
  setupTestDb,
  connectTestRedis,
  unlimitedLimiter,
  seatInStore,
  insertUser,
  insertMeeting,
} = require('./helpers');

const API_KEY = 'devkey';
const API_SECRET = 'secret';

// dotenv is never loaded in tests (see server.js) — save/restore so a real
// developer .env sitting in process.env from some other tool can't leak in.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const noEnv = { LIVEKIT_URL: undefined, LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined };

test('createLivekit returns null when any LiveKit setting is missing', () =>
  withEnv(noEnv, async () => {
    assert.equal(createLivekit({ url: '', apiKey: API_KEY, apiSecret: API_SECRET }), null);
    assert.equal(createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: undefined, apiSecret: API_SECRET }), null);
    assert.equal(createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: undefined }), null);
    assert.notEqual(
      createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} }),
      null,
    );
  }));

test('mintToken grants exactly what the spec allows, and nothing more', async () => {
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  const jwt = await livekit.mintToken({ meetingId: 'meeting-1', userId: 'user-1', name: 'Ada' });

  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(jwt);
  assert.equal(claims.sub, 'user-1');
  assert.equal(claims.name, 'Ada');
  assert.equal(claims.video.room, 'meeting-1');
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.canPublish, true);
  assert.deepEqual(claims.video.canPublishSources, ['camera', 'microphone']);
  assert.equal(claims.video.roomAdmin, undefined);
  assert.equal(claims.video.roomCreate, undefined);
  // The field-by-field asserts above don't catch a stray extra grant
  // (canPublishData, hidden, roomList, ...) slipping in — this does.
  assert.deepEqual(claims.video, {
    roomJoin: true,
    room: 'meeting-1',
    canSubscribe: true,
    canPublish: true,
    canPublishSources: ['camera', 'microphone'],
  });
});

test('mintToken issues a 10-minute token', async () => {
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  const jwt = await livekit.mintToken({ meetingId: 'meeting-1', userId: 'user-1', name: 'Ada' });

  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(jwt);
  assert.equal(claims.exp - claims.nbf, 600);
});

test('the browser url comes back untouched', () => {
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  assert.equal(livekit.url, 'ws://127.0.0.1:7880');
});

test("ensureRoom creates the room with the meeting's cap and a 5-minute empty timeout", async () => {
  let received;
  const rooms = {
    createRoom: async (options) => {
      received = options;
    },
  };
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms });

  await livekit.ensureRoom('meeting-1', 7);

  assert.deepEqual(received, { name: 'meeting-1', maxParticipants: 7, emptyTimeout: 300 });
});

test('ensureRoom propagates an upstream failure to its caller', async () => {
  const rooms = {
    createRoom: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:7880');
    },
  };
  const livekit = createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms });

  await assert.rejects(() => livekit.ensureRoom('meeting-1', 7));
});

test('ping rejects when LiveKit does not answer', async () => {
  const down = createLivekit({
    url: 'ws://127.0.0.1:7880',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    rooms: {
      listRooms: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:7880');
      },
    },
  });
  await assert.rejects(() => down.ping());

  const up = createLivekit({
    url: 'ws://127.0.0.1:7880',
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    rooms: { listRooms: async () => [] },
  });
  await assert.doesNotReject(() => up.ping());
});

// --- GET /api/meetings/:id/livekit-token -----------------------------------
//
// mintToken below is always the real one from createLivekit (so the JWT is
// genuinely signed and verifiable); only ensureRoom/ping are recording stubs,
// so a test can watch what the room-creation call looked like without a real
// LiveKit server.
const MEETING_ID = 'tok-enme-eet';
const MISSING_MEETING_ID = 'zzz-zzzz-zzz';
const FAKE_LIVEKIT_URL = 'ws://fake-livekit.test';

function fakeLivekit() {
  const livekit = createLivekit({ url: FAKE_LIVEKIT_URL, apiKey: API_KEY, apiSecret: API_SECRET, rooms: {} });
  const ensureRoomCalls = [];
  // One shared log for both calls, not two separate flags, so a test can assert
  // the actual sequence (ensureRoom before mintToken) rather than just that both
  // happened — a reordering bug must be able to fail this.
  const callOrder = [];
  const realMintToken = livekit.mintToken;
  livekit.ensureRoom = async (meetingId, maxParticipants) => {
    ensureRoomCalls.push([meetingId, maxParticipants]);
    callOrder.push('ensureRoom');
  };
  livekit.mintToken = async (...args) => {
    callOrder.push('mintToken');
    return realMintToken(...args); // still the real signer — JWT stays genuine
  };
  livekit.ping = async () => {};
  return { livekit, ensureRoomCalls, callOrder };
}

async function tokenApi(server, userId, id) {
  const res = await fetch(`${server.base}/api/meetings/${id}/livekit-token`, {
    headers: userId ? { 'x-test-user': userId } : {},
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let tokenDb;
let redis; // one Redis for the file; each test that seats someone clears its meeting afterwards
let store;
let good; // working livekit: real mintToken, recording ensureRoom/ping stubs
let noLivekit; // app built with livekit: null
let broken; // livekit whose ensureRoom rejects the way the real server does when unreachable

before(async () => {
  tokenDb = await setupTestDb();
  redis = await connectTestRedis();
  store = createRoomStore(redis, { serverId: 'test' });
  await insertUser(tokenDb, { id: 'host', email: 'host@zylo.test', name: 'Hana Host' });
  // Deliberately NOT 'Priya One' — the seat is given that name below, and the
  // whole point of test 5 is that the token's name can only come from the seat,
  // never from a users-table lookup. If a future refactor joined users instead
  // of reading seat.name, this mismatch is what would make that test fail.
  await insertUser(tokenDb, { id: 'p1', email: 'p1@zylo.test', name: 'Priya DB' });
  await insertUser(tokenDb, { id: 'p2', email: 'p2@zylo.test', name: 'Pablo Two' });
  await insertMeeting(tokenDb, { id: MEETING_ID, hostId: 'host', maxParticipants: 20 });

  const { livekit, ensureRoomCalls, callOrder } = fakeLivekit();
  good = {
    livekit, ensureRoomCalls, callOrder,
    server: await listen(createApp({ db: tokenDb, auth: fakeAuth, livekit, store, limiter: unlimitedLimiter })),
  };
  noLivekit = { server: await listen(createApp({ db: tokenDb, auth: fakeAuth, livekit: null, store, limiter: unlimitedLimiter })) };

  const brokenLivekit = fakeLivekit().livekit;
  // The real observed failure: LiveKit's ServerError carries `.status = 401` —
  // a bare Error would produce a 500 from app.js's error middleware and would
  // not reproduce the actual bug this route guards against.
  brokenLivekit.ensureRoom = async () => {
    throw Object.assign(
      new Error('invalid authorization token: token signature is invalid: signature is invalid'),
      { name: 'Unauthorized', status: 401 },
    );
  };
  broken = { server: await listen(createApp({ db: tokenDb, auth: fakeAuth, livekit: brokenLivekit, store, limiter: unlimitedLimiter })) };
});

after(async () => {
  await good.server.close();
  await noLivekit.server.close();
  await broken.server.close();
  await tokenDb.close();
});

// Its own hook: a before() that failed halfway must still close the connection.
after(() => redis?.disconnect());

test('a malformed meeting code is rejected before anything else', async () => {
  const { status, body } = await tokenApi(good.server, 'p1', 'not-a-code');
  assert.equal(status, 400);
  assert.match(body.error, /meeting code/);
});

test('a token request with no session is refused', async () => {
  const { status } = await tokenApi(good.server, null, MEETING_ID);
  assert.equal(status, 401);
});

test('a token request is refused when LiveKit is not configured', async () => {
  const { status, body } = await tokenApi(noLivekit.server, 'p1', MEETING_ID);
  assert.equal(status, 503);
  assert.match(body.error, /LIVEKIT/);
});

test('a token request without a seat is refused', async () => {
  const { status, body } = await tokenApi(good.server, 'p1', MEETING_ID);
  assert.equal(status, 403);
  assert.match(body.error, /seat/i);
});

test('a seat holder gets a token scoped to their meeting and identity', async (t) => {
  await seatInStore(store, MEETING_ID, { userId: 'p1', socketId: 's1', name: 'Priya One' });
  t.after(() => store.clearMeeting(MEETING_ID));

  const { status, body } = await tokenApi(good.server, 'p1', MEETING_ID);
  assert.equal(status, 200);
  assert.equal(body.url, FAKE_LIVEKIT_URL);

  const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(body.token);
  assert.equal(claims.sub, 'p1');
  assert.equal(claims.name, 'Priya One'); // the seat's name, not the DB user's ('Priya DB') or the request's
  assert.equal(claims.video.room, MEETING_ID);
  assert.equal(claims.video.roomAdmin, undefined);
});

test("the LiveKit room is created with the meeting's cap before the token is minted", async (t) => {
  await seatInStore(store, MEETING_ID, { userId: 'p1', socketId: 's1', name: 'Priya One' });
  t.after(() => store.clearMeeting(MEETING_ID));
  good.ensureRoomCalls.length = 0;
  good.callOrder.length = 0;

  const { status } = await tokenApi(good.server, 'p1', MEETING_ID);
  assert.equal(status, 200);
  assert.deepEqual(good.ensureRoomCalls, [[MEETING_ID, 20]]);
  // The name promises an order, not just that both were called — this is what
  // would fail if a reorder ever called mintToken first.
  assert.deepEqual(good.callOrder, ['ensureRoom', 'mintToken']);
});

test('a seat for a meeting that no longer exists gets 404, not 500', async (t) => {
  await seatInStore(store, MISSING_MEETING_ID, { userId: 'p1', socketId: 's2', name: 'Priya One' });
  t.after(() => store.clearMeeting(MISSING_MEETING_ID));

  const { status } = await tokenApi(good.server, 'p1', MISSING_MEETING_ID);
  assert.equal(status, 404);
});

test('a removed user is refused even though they still hold a seat', async (t) => {
  await seatInStore(store, MEETING_ID, { userId: 'p2', socketId: 's3', name: 'Pablo Two' });
  t.after(() => store.clearMeeting(MEETING_ID));
  await tokenDb.query(
    `INSERT INTO meeting_participants (meeting_id, user_id, role, removed_at) VALUES ($1, 'p2', 'participant', now())`,
    [MEETING_ID],
  );

  const { status, body } = await tokenApi(good.server, 'p2', MEETING_ID);
  assert.equal(status, 403);
  assert.match(body.error, /removed/i);
});

test('an unreachable LiveKit is a 503, not a 500', async (t) => {
  await seatInStore(store, MEETING_ID, { userId: 'p1', socketId: 's4', name: 'Priya One' });
  t.after(() => store.clearMeeting(MEETING_ID));

  const { status, body } = await tokenApi(broken.server, 'p1', MEETING_ID);
  assert.equal(status, 503);
  // The two wrong answers a naive implementation could give: 401 is what the
  // real LiveKit ServerError's .status actually produces without the route's
  // try/catch (see app.js's error middleware); 500 is what the brief warned
  // about but isn't the real failure mode.
  assert.notEqual(status, 401);
  assert.notEqual(status, 500);
  assert.match(body.error, /video server/i);
});

// --- Phase 4 enforcement calls -----------------------------------------------
// recordingRooms() stands in for RoomServiceClient and logs every call in order;
// an override replaces one method (and is not logged).
function recordingRooms(overrides = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return result; };
  return {
    calls,
    rooms: {
      updateParticipant: rec('updateParticipant', {}),
      removeParticipant: rec('removeParticipant'),
      deleteRoom: rec('deleteRoom'),
      mutePublishedTrack: rec('mutePublishedTrack', {}),
      getParticipant: rec('getParticipant', { tracks: [] }),
      ...overrides,
    },
  };
}
const withRooms = (rooms) => createLivekit({ url: 'ws://127.0.0.1:7880', apiKey: API_KEY, apiSecret: API_SECRET, rooms });
const upstreamDown = async () => { throw Object.assign(new Error('fetch failed'), { status: 503 }); };
const notFound = async () => { throw Object.assign(new Error('participant not found'), { status: 404, code: 'not_found' }); };
const cameraMic = [TrackSource.CAMERA, TrackSource.MICROPHONE];

test('grantScreenShare adds the screen and its audio to camera and microphone', async () => {
  const { calls, rooms } = recordingRooms();
  const livekit = withRooms(rooms);

  await livekit.grantScreenShare('meeting-1', 'user-1');

  assert.deepEqual(calls, [
    ['updateParticipant', 'meeting-1', 'user-1', {
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishSources: [...cameraMic, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
      },
    }],
  ]);
});

test('grantScreenShare lets an upstream failure reach its caller', async () => {
  const { rooms } = recordingRooms({ updateParticipant: upstreamDown });
  const livekit = withRooms(rooms);

  await assert.rejects(() => livekit.grantScreenShare('meeting-1', 'user-1'), { status: 503 });
});

test('revokeScreenShare puts the permission back to camera and microphone, and never rejects', async () => {
  const { calls, rooms } = recordingRooms();
  const livekit = withRooms(rooms);

  await livekit.revokeScreenShare('meeting-1', 'user-1');

  assert.deepEqual(calls, [
    ['updateParticipant', 'meeting-1', 'user-1', { permission: { canSubscribe: true, canPublish: true, canPublishSources: cameraMic } }],
  ]);

  const down = withRooms(recordingRooms({ updateParticipant: upstreamDown }).rooms);
  await assert.doesNotReject(() => down.revokeScreenShare('meeting-1', 'user-1'));
});

test('evict removes the participant, and never rejects — a 404 is the normal case', async () => {
  const { calls, rooms } = recordingRooms();
  const livekit = withRooms(rooms);

  await livekit.evict('meeting-1', 'user-1');

  assert.deepEqual(calls, [['removeParticipant', 'meeting-1', 'user-1']]);

  const gone = withRooms(recordingRooms({ removeParticipant: notFound }).rooms);
  await assert.doesNotReject(() => gone.evict('meeting-1', 'user-1'));

  const down = withRooms(recordingRooms({ removeParticipant: upstreamDown }).rooms);
  await assert.doesNotReject(() => down.evict('meeting-1', 'user-1'));
});

test('muteMic mutes the live microphone track and nothing else', async () => {
  const { calls, rooms } = recordingRooms({
    getParticipant: async () => ({
      tracks: [
        { sid: 'TR_cam', source: TrackSource.CAMERA, muted: false },
        { sid: 'TR_mic', source: TrackSource.MICROPHONE, muted: false },
      ],
    }),
  });
  const livekit = withRooms(rooms);

  await livekit.muteMic('meeting-1', 'user-1');

  // getParticipant is an override here (see recordingRooms), so it is not logged —
  // only the mutePublishedTrack call this test cares about shows up.
  assert.deepEqual(calls, [['mutePublishedTrack', 'meeting-1', 'user-1', 'TR_mic', true]]);

  const alreadyMuted = recordingRooms({
    getParticipant: async () => ({ tracks: [{ sid: 'TR_mic', source: TrackSource.MICROPHONE, muted: true }] }),
  });
  await withRooms(alreadyMuted.rooms).muteMic('meeting-1', 'user-1');
  assert.deepEqual(alreadyMuted.calls, []);

  const gone = withRooms(recordingRooms({ getParticipant: notFound }).rooms);
  await assert.doesNotReject(() => gone.muteMic('meeting-1', 'user-1'));
});

test('endRoom deletes the room, and never rejects', async () => {
  const { calls, rooms } = recordingRooms();
  const livekit = withRooms(rooms);

  await livekit.endRoom('meeting-1');

  assert.deepEqual(calls, [['deleteRoom', 'meeting-1']]);

  const down = withRooms(recordingRooms({ deleteRoom: upstreamDown }).rooms);
  await assert.doesNotReject(() => down.endRoom('meeting-1'));
});

test('a seat released while the room is being created gets 403, not a token', async (t) => {
  const { livekit } = fakeLivekit();
  // The race the re-check exists for: a kick, a Leave or a grace expiry lands
  // during the ensureRoom await, after the route's first seat check passed.
  livekit.ensureRoom = async () => {
    await store.releaseSeat(MEETING_ID, 'p1');
  };
  const server = await listen(createApp({ db: tokenDb, auth: fakeAuth, livekit, store, limiter: unlimitedLimiter }));
  t.after(async () => {
    await server.close();
    await store.clearMeeting(MEETING_ID);
  });
  await seatInStore(store, MEETING_ID, { userId: 'p1', socketId: 's5', name: 'Priya One' });

  const { status, body } = await tokenApi(server, 'p1', MEETING_ID);
  assert.equal(status, 403);
  assert.equal(body.token, undefined);
});
