const express = require('express');
const { generateCode, isValidCode, validateCreateMeeting } = require('./meetingRules');
const { limitRequests } = require('./limitMiddleware');
const { log } = require('./log');

const HOUR_MS = 60 * 60 * 1000;

const CARD_SELECT = `
  SELECT m.*, h.name AS host_name,
    EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1) AS attended,
    COALESCE((
      SELECT json_agg(json_build_object('name', u.name, 'imageUrl', u.image_url) ORDER BY p.first_joined_at)
      FROM meeting_participants p JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = m.id AND p.removed_at IS NULL
    ), '[]'::json) AS participants
  FROM meetings m
  JOIN users h ON h.id = m.host_id`;

const iso = (date) => (date ? date.toISOString() : null);

function toCard(row, userId, aiAvailable) {
  return {
    id: row.id,
    title: row.title,
    status: row.ended_at ? 'ended' : row.started_at ? 'live' : 'scheduled',
    scheduledFor: iso(row.scheduled_for),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    admission: row.admission,
    screenSharePolicy: row.screen_share_policy,
    maxParticipants: row.max_participants,
    mode: row.mode,
    aiEnabled: row.ai_enabled,
    aiNudges: row.ai_nudges,
    aiAvailable,
    host: { name: row.host_name },
    isHost: row.host_id === userId,
    participants: row.participants,
  };
}

async function getCard(db, id, userId, aiAvailable) {
  const { rows } = await db.query(`${CARD_SELECT} WHERE m.id = $2`, [userId, id]);
  return rows[0] ? toCard(rows[0], userId, aiAvailable) : null;
}

// aiAvailable: whether this server has AI configured, stamped on every card it returns.
function meetingsRouter(db, livekit, limiter, store, aiAvailable = false) {
  const router = express.Router();
  // Per user, on top of the app-wide 'api' limit: creating can spam, lookups can
  // guess codes, and every token request makes a call to LiveKit.
  const perUser = (policy) => limitRequests(limiter, policy, (req) => req.userId);

  router.get('/dashboard', async (req, res) => {
    // ponytail: newest 200 visible meetings, bucketed in JS; paginate Previous when users outgrow it.
    const { rows } = await db.query(
      `${CARD_SELECT}
       WHERE m.host_id = $1
          OR EXISTS (SELECT 1 FROM meeting_invites i
                     WHERE i.meeting_id = m.id AND i.email = (SELECT email FROM users WHERE id = $1))
          OR EXISTS (SELECT 1 FROM meeting_participants p WHERE p.meeting_id = m.id AND p.user_id = $1)
       ORDER BY (m.ended_at IS NULL) DESC, COALESCE(m.ended_at, m.scheduled_for, m.created_at) DESC
       LIMIT 200`,
      [req.userId],
    );

    const now = Date.now();
    const live = [];
    const upcoming = [];
    const previous = [];
    for (const row of rows) {
      const card = toCard(row, req.userId, aiAvailable);
      if (row.started_at && !row.ended_at) live.push(card);
      else if (!row.started_at && !row.ended_at && row.scheduled_for && row.scheduled_for.getTime() >= now - HOUR_MS) {
        upcoming.push(card);
      } else if (row.ended_at && row.attended) previous.push(card);
    }
    upcoming.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));

    res.json({ live, upcoming, previous: previous.slice(0, 50) });
  });

  router.post('/meetings', perUser('create'), async (req, res) => {
    const { value, error } = validateCreateMeeting(req.body);
    if (error) return res.status(400).json({ error });

    for (let attempt = 0; attempt < 2; attempt++) {
      const id = generateCode();
      try {
        await db.query(
          `WITH m AS (
             INSERT INTO meetings (id, host_id, title, admission, screen_share_policy, max_participants, scheduled_for, mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $9) RETURNING id
           ), invites AS (
             INSERT INTO meeting_invites (meeting_id, email) SELECT m.id, unnest($8::text[]) FROM m
           )
           SELECT id FROM m`,
          [id, req.userId, value.title, value.admission, value.screenSharePolicy, value.maxParticipants,
            value.scheduledFor, value.inviteEmails, value.mode],
        );
        return res.status(201).json({ meeting: await getCard(db, id, req.userId, aiAvailable) });
      } catch (err) {
        if (err.code === '23505' && attempt === 0) continue; // meeting code collision: retry once
        throw err;
      }
    }
  });

  router.get('/meetings/:id', perUser('lookup'), async (req, res) => {
    if (!isValidCode(req.params.id)) return res.status(400).json({ error: 'That is not a valid meeting code.' });
    const meeting = await getCard(db, req.params.id, req.userId, aiAvailable);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });
    res.json({ meeting, isHost: meeting.isHost });
  });

  router.get('/meetings/:id/livekit-token', perUser('lkToken'), async (req, res) => {
    const { id } = req.params;
    if (!isValidCode(id)) return res.status(400).json({ error: 'That is not a valid meeting code.' });
    if (!livekit) return res.status(503).json({ error: 'LIVEKIT is not configured on the server.' });

    const seat = store ? await store.seatFor(id, req.userId) : null;
    if (!seat) return res.status(403).json({ error: 'You do not hold a seat in this meeting.' });

    const { rows } = await db.query(
      `SELECT m.max_participants, p.removed_at
       FROM meetings m
       LEFT JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = $2
       WHERE m.id = $1`,
      [id, req.userId],
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Meeting not found.' });
    if (row.removed_at) return res.status(403).json({ error: 'You have been removed from this meeting.' });

    try {
      // LiveKit is the only out-of-process dependency on this path with a documented
      // failure status: its ServerError carries .status = 401, which the error
      // middleware would forward as "not signed in" to someone who is. Narrow on
      // purpose — wraps exactly the upstream call.
      await livekit.ensureRoom(id, row.max_participants);
    } catch (err) {
      log.error('livekit room creation failed', { meetingId: id, userId: req.userId, err: err.message });
      return res.status(503).json({ error: 'The video server is unavailable right now.' });
    }

    // Re-check after the awaits above: a kick, a Leave or a grace expiry can release
    // the seat while the DB query and ensureRoom are in flight, and a token minted
    // now would outlive the seat by 10 minutes.
    if (!(await store.seatFor(id, req.userId))) return res.status(403).json({ error: 'You do not hold a seat in this meeting.' });

    // Local signing, no network: nothing here for the 503 mapping to cover.
    const token = await livekit.mintToken({ meetingId: id, userId: req.userId, name: seat.name });
    res.json({ token, url: livekit.url });
  });

  router.delete('/meetings/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidCode(id)) return res.status(400).json({ error: 'That is not a valid meeting code.' });

    // Single conditional DELETE, so a meeting that starts concurrently can't be cancelled.
    const { rowCount } = await db.query(
      'DELETE FROM meetings WHERE id = $1 AND host_id = $2 AND started_at IS NULL',
      [id, req.userId],
    );
    if (rowCount === 1) return res.status(204).end();

    const { rows } = await db.query('SELECT host_id FROM meetings WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Meeting not found.' });
    if (rows[0].host_id !== req.userId) return res.status(403).json({ error: 'Only the host can cancel this meeting.' });
    return res.status(409).json({ error: 'This meeting has already started.' });
  });

  return router;
}

module.exports = { meetingsRouter };
