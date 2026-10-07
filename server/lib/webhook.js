const express = require('express');
const { isValidCode } = require('./meetingRules');
const { log } = require('./log');

// POST /livekit/webhook. LiveKit calls this, not a browser, so it is authenticated
// by LiveKit's signature — a JWT in Authorization, signed with our API secret and
// carrying the body's sha256 — never by Clerk. The signature covers the exact
// bytes, so this route reads the raw body itself, whatever the content type
// (LiveKit sends application/webhook+json), and app.js mounts it before
// express.json() can parse anything.
//
// Its one job closes the gap Phase 3 left: a token outlives the seat that earned it
// by up to 10 minutes, so an identity joining the media room without a seat right
// now is evicted on arrival.
// ponytail: they are in the room for one webhook round trip (tens of ms) first.
// removeParticipant's revokeTokenTs would refuse them at the door; adopt it once
// it is confirmed on the livekit-server version we deploy.
function livekitWebhook(livekit, store) {
  const router = express.Router();
  router.post('/livekit/webhook', express.raw({ type: () => true, limit: '64kb' }), async (req, res) => {
    let event;
    try {
      const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      event = await livekit.receiveWebhook(body, req.get('authorization'));
    } catch (err) {
      log.error('livekit webhook rejected', { err: err.message });
      return res.status(401).json({ error: 'Invalid webhook signature.' });
    }
    if (event.event === 'participant_joined') {
      const meetingId = event.room?.name;
      const userId = event.participant?.identity;
      // Meeting rooms only — which is also what keeps the opt-in live tests (rooms
      // named live-test-*) from being evicted by a dev API server.
      // No store means no rooms at all, so nobody holds a seat.
      if (isValidCode(meetingId) && userId && !(store && (await store.hasSeat(meetingId, userId)))) {
        livekit.evict(meetingId, userId); // never rejects: see lib/livekit.js
      }
    }
    res.status(200).end();
  });
  return router;
}

module.exports = { livekitWebhook };
