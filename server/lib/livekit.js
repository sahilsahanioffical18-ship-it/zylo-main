const { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } = require('livekit-server-sdk');
const { log } = require('./log');

const TOKEN_TTL = '10m';
const EMPTY_TIMEOUT = 300;

// What a seat earns through its token, and what a ZyloLive grant adds on top.
const CAMERA_MIC = [TrackSource.CAMERA, TrackSource.MICROPHONE];
const WITH_SCREEN = [...CAMERA_MIC, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

// updateParticipant replaces the whole permission atomically, so every call spells
// all of it out. Side effect: canPublishData (left at LiveKit's default of true by
// the token) becomes false after the first update. Zylo publishes no data.
const permission = (sources) => ({ canSubscribe: true, canPublish: true, canPublishSources: sources });

// For enforcement calls that must never stall or crash the socket handler that
// made them. The target may never have connected (a 404 is the normal case — a
// lobby user's seat, a tab that closed first), and a LiveKit failure must not undo
// the seat bookkeeping around the call. Anything but not-found is still logged.
const quiet = (what, meetingId, userId) => (err) => {
  if (err?.status !== 404) log.error(`livekit ${what} failed`, { meetingId, userId, err: err?.message });
};

function createLivekit({ url, apiKey, apiSecret, rooms } = {}) {
  url = url ?? process.env.LIVEKIT_URL;
  apiKey = apiKey ?? process.env.LIVEKIT_API_KEY;
  apiSecret = apiSecret ?? process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) return null;

  // RoomServiceClient rewrites ws(s):// to http(s):// internally for its own
  // RPC calls; `url` below stays ws:// as-is because the browser client needs
  // that scheme to connect.
  const roomService = rooms || new RoomServiceClient(url, apiKey, apiSecret);
  const webhooks = new WebhookReceiver(apiKey, apiSecret);

  return {
    url,
    ping: () => roomService.listRooms([]),
    // No memo: a per-process cache would skip re-creating a room after
    // livekit-server restarts, silently dropping the maxParticipants cap.
    ensureRoom: (meetingId, maxParticipants) =>
      roomService.createRoom({ name: meetingId, maxParticipants, emptyTimeout: EMPTY_TIMEOUT }),
    mintToken: async ({ meetingId, userId, name }) => {
      const token = new AccessToken(apiKey, apiSecret, { identity: userId, name, ttl: TOKEN_TTL });
      token.addGrant({
        roomJoin: true,
        room: meetingId,
        canSubscribe: true,
        canPublish: true,
        canPublishSources: CAMERA_MIC,
      });
      return token.toJwt();
    },
    // A released seat must end the media session too: the seat is the only thing
    // that authorizes media.
    evict: (meetingId, userId) => roomService.removeParticipant(meetingId, userId).catch(quiet('evict', meetingId, userId)),
    endRoom: (meetingId) => roomService.deleteRoom(meetingId).catch(quiet('end room', meetingId)),
    // The one call here that rejects: screen:request must be able to tell the
    // person that ZyloLive did not start.
    grantScreenShare: async (meetingId, userId) => {
      await roomService.updateParticipant(meetingId, userId, { permission: permission(WITH_SCREEN) });
    },
    revokeScreenShare: (meetingId, userId) =>
      roomService
        .updateParticipant(meetingId, userId, { permission: permission(CAMERA_MIC) })
        .then(() => {}, quiet('revoke screen share', meetingId, userId)),
    // host:mute. Only a live, unmuted microphone; the person can unmute themselves.
    muteMic: async (meetingId, userId) => {
      try {
        const { tracks } = await roomService.getParticipant(meetingId, userId);
        const mic = tracks.find((t) => t.source === TrackSource.MICROPHONE);
        if (mic && !mic.muted) await roomService.mutePublishedTrack(meetingId, userId, mic.sid, true);
      } catch (err) {
        quiet('mute', meetingId, userId)(err);
      }
    },
    // The signature is lib/webhook.js's only authentication: never skipAuth.
    receiveWebhook: (body, authorization) => webhooks.receive(body, authorization),
  };
}

module.exports = { createLivekit };
