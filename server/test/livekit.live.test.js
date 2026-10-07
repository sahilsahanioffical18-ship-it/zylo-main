const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { RoomServiceClient, TrackSource } = require('livekit-server-sdk');
const { createLivekit } = require('../lib/livekit');

const LIVE = Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
// dotenv only loads in server.js, so server/.env is invisible here on purpose:
// these run only when someone deliberately exports the env on the command line.
const skip = LIVE ? false : 'LiveKit env not set — run `npm run livekit`, then re-run with LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET exported';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

// deleteRoom isn't on the createLivekit surface (Task 2 left it out on purpose —
// it's Phase 4 scope), so cleanup here talks to the real SDK client directly.
const rooms = LIVE ? new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) : null;

let n = 0;
// pid-scoped names so a crashed run can't collide with or poison the next one.
const nextRoomName = () => `live-test-${process.pid}-${++n}`;

// Loaded only when these tests run: a default `npm test` never touches the binding.
const rtc = LIVE ? require('@livekit/rtc-node') : null;
after(() => rtc?.dispose()); // the native FFI keeps the process alive until disposed

const liveClient = () => createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The server's view catches up with a publish/unpublish asynchronously.
async function waitFor(check, ms = 5000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) {
    if (await check()) return true;
  }
  return check();
}

// A real participant holding exactly the camera/microphone token a browser gets.
async function join(t, roomName, identity) {
  const livekit = liveClient();
  await livekit.ensureRoom(roomName, 3);
  const token = await livekit.mintToken({ meetingId: roomName, userId: identity, name: identity });
  const room = new rtc.Room();
  await room.connect(LIVEKIT_URL, token, { autoSubscribe: false, dynacast: false });
  t.after(() => room.disconnect());
  return room;
}
function publishScreen(room) {
  const source = new rtc.VideoSource(64, 64);
  const track = rtc.LocalVideoTrack.createVideoTrack('screen', source);
  source.captureFrame(new rtc.VideoFrame(new Uint8Array(64 * 64 * 4), 64, 64, rtc.VideoBufferType.RGBA));
  return room.localParticipant.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_SCREENSHARE }));
}
function publishMic(room) {
  const track = rtc.LocalAudioTrack.createAudioTrack('mic', new rtc.AudioSource(48000, 1));
  return room.localParticipant.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
}
const serverTracks = async (roomName, identity) => (await rooms.getParticipant(roomName, identity)).tracks;
const hasScreen = async (roomName, identity) =>
  (await serverTracks(roomName, identity)).some((track) => track.source === TrackSource.SCREEN_SHARE);
const micTrack = async (roomName, identity) =>
  (await serverTracks(roomName, identity)).find((track) => track.source === TrackSource.MICROPHONE);

// --- L5-L8: does revoking the screen-share source unpublish a live track? ---------

test(
  'a screen share cannot be published on the camera/microphone token alone',
  { skip, timeout: 30_000 },
  async (t) => {
    const roomName = nextRoomName();
    t.after(() => rooms.deleteRoom(roomName));
    const room = await join(t, roomName, 'no-grant');

    const outcome = await Promise.race([
      publishScreen(room).then(() => 'published', () => 'refused'),
      sleep(10_000).then(() => 'no answer'),
    ]);
    // Observed against the real server (livekit-server 1.13.x dev instance): the
    // server never sends an explicit permission-denied response for a publish
    // outside canPublishSources — it silently drops the request. publishTrack()
    // does eventually reject ('refused'), but only because rtc-node's own client
    // has a ~10s internal timeout ("track publication timed out, no response
    // received from the server"), the same ~10s as this test's own "no answer"
    // fallback. Either outcome is "not published"; the assertion below doesn't
    // depend on which one wins the race.
    assert.notEqual(outcome, 'published');
    assert.equal(await hasScreen(roomName, 'no-grant'), false);
  },
);

test(
  'revoking the screen-share source unpublishes a live screen share',
  { skip, timeout: 30_000 },
  async (t) => {
    const roomName = nextRoomName();
    t.after(() => rooms.deleteRoom(roomName));
    const livekit = liveClient();
    const room = await join(t, roomName, 'sharer');

    await livekit.grantScreenShare(roomName, 'sharer');
    await publishScreen(room);
    assert.ok(await waitFor(() => hasScreen(roomName, 'sharer')), 'the grant did not let the screen share publish');

    await livekit.revokeScreenShare(roomName, 'sharer');
    // THE answer: yes — revoking canPublishSources unpublishes the live track server-side.
    assert.ok(
      await waitFor(async () => !(await hasScreen(roomName, 'sharer'))),
      'LiveKit left the screen share published after its source was revoked',
    );
  },
);

test(
  'evicting a participant disconnects them, and evicting someone absent is quiet',
  { skip, timeout: 30_000 },
  async (t) => {
    const roomName = nextRoomName();
    t.after(() => rooms.deleteRoom(roomName));
    const livekit = liveClient();
    const room = await join(t, roomName, 'evictee');

    const gone = new Promise((res) => room.once(rtc.RoomEvent.Disconnected, res));
    await livekit.evict(roomName, 'evictee');
    assert.equal(await gone, rtc.DisconnectReason.PARTICIPANT_REMOVED);

    await assert.doesNotReject(() => livekit.evict(roomName, 'nobody-here'));
    // Observed status for a not-found participant against the real server: 404.
    await assert.rejects(() => rooms.removeParticipant(roomName, 'nobody-here'), { status: 404 });
  },
);

test("a host mute lands on the participant's microphone", { skip, timeout: 30_000 }, async (t) => {
  const roomName = nextRoomName();
  t.after(() => rooms.deleteRoom(roomName));
  const livekit = liveClient();
  const room = await join(t, roomName, 'muted');

  await publishMic(room);
  assert.ok(await waitFor(async () => Boolean(await micTrack(roomName, 'muted'))), 'the microphone did not publish');

  await livekit.muteMic(roomName, 'muted');
  assert.ok(
    await waitFor(async () => (await micTrack(roomName, 'muted'))?.muted === true),
    'the server mute did not land',
  );
});

test('ensureRoom creates a real room with the cap and empty timeout we asked for', { skip }, async (t) => {
  const roomName = nextRoomName();
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
  t.after(() => rooms.deleteRoom(roomName));

  await livekit.ensureRoom(roomName, 3);

  const [room] = await rooms.listRooms([roomName]);
  assert.equal(room.maxParticipants, 3);
  assert.equal(room.emptyTimeout, 300);
});

test('calling ensureRoom twice for the same meeting is safe', { skip }, async (t) => {
  const roomName = nextRoomName();
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
  t.after(() => rooms.deleteRoom(roomName));

  // The idempotency question Task 4 depends on: does a second createRoom for
  // the same name resolve, or reject? Observed against a real livekit-server
  // 1.13.7 dev instance: it resolves both times (createRoom is idempotent by
  // room name), so Task 4 needs no catch for an already-exists error. If this
  // assertion ever starts failing against a different server version, that's
  // the answer flipping — change it to assert.rejects with the real error
  // shape instead of forcing doesNotReject to stay green.
  await livekit.ensureRoom(roomName, 3);
  await assert.doesNotReject(() => livekit.ensureRoom(roomName, 3));
});

test('a brand-new room has no participants', { skip }, async (t) => {
  const roomName = nextRoomName();
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET });
  t.after(() => rooms.deleteRoom(roomName));

  await livekit.ensureRoom(roomName, 3);

  const participants = await rooms.listParticipants(roomName);
  assert.deepEqual(participants, []);
});

test('a wrong API secret is rejected by the real server', { skip }, async () => {
  // Observed shape (livekit-server 1.13.7): a ServerError with status 401,
  // name "Unauthorized", message "invalid authorization token: token
  // signature is invalid: signature is invalid" — this is what Task 4's
  // 503-mapping path is built against.
  const livekit = createLivekit({ url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: 'wrong-secret' });
  await assert.rejects(() => livekit.ping(), { status: 401 });
});
