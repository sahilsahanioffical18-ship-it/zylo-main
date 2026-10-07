const { randomUUID } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { validateChatText } = require('./chatRules');
const { promptFor } = require('./ai');
const { goingInCircles, isQuiet, NUDGE_PROMPT, nudgeText, quietLongEnough, stuckPhrase } = require('./nudge');
const { isConvoLang, validateCaption } = require('./captionRules');
const { isValidCode } = require('./meetingRules');
const { SOCKET_POLICIES, takeToken } = require('./rateLimit');
const { GRACE_MS } = require('./roomStore');
const { log } = require('./log');

const roomChannel = (meetingId) => `meeting:${meetingId}`;

// Every meeting:settings carries the host's four live settings.
const settingsOf = ({ admission, screenSharePolicy, aiEnabled, aiNudges }) => ({ admission, screenSharePolicy, aiEnabled, aiNudges });

const SWEEP_MS = 15_000;
const HEARTBEAT_MS = 10_000;
const IDLE_ROOM_MS = 60_000;
// An answer's pieces go out at most once per this many ms, so a fast stream doesn't
// flood the adapter.
const AI_CHUNK_MS = 100;
const AI_NAME = 'Zylo AI';
const AI_FAILED = "The AI couldn't answer. Try again.";
// A nudge is one or two sentences.
const NUDGE_MAX_TOKENS = 200;

// Per-socket buckets (SOCKET_POLICIES). A socket lives on one server for its whole
// life, so these need no Redis round trip; captions are the busiest event in Zylo.
// The per-IP connection limit (limitConnections) stops a reconnect from buying a
// fresh bucket.
function allowEvent(socket, name) {
  const { rate, burst } = SOCKET_POLICIES[name];
  const now = Date.now();
  const buckets = (socket.data.buckets ??= {});
  return takeToken((buckets[name] ??= { tokens: burst, at: now }), now, rate, burst);
}

// Seats, the lobby, the screen-share lock and live settings live in the room store
// (Redis), shared by every API server. A socket may live on another server, so
// sockets are reached by id: io.to(id) sends, io.in(id).socketsJoin/socketsLeave
// moves it, io.in(id).fetchSockets() asks whether it's still connected. All of these
// work with the default in-memory adapter too. socket.data.meetingId is only a hint:
// every handler that acts checks in the store that this socket holds the seat or
// lobby entry it acts through.
// history: each meeting's last 20 chat lines, which Zylo AI reads (chatHistory.js).
// limiter: the shared rate limits (rateLimit.js); ai:ask and nudges take from it. ai: the
// provider client (ai.js), null when this server has no key or model.
function registerRoomHandlers(
  io,
  {
    db,
    store,
    history,
    limiter,
    ai = null,
    livekit = null,
    graceMs = GRACE_MS,
    sweepMs = SWEEP_MS,
    idleRoomMs = IDLE_ROOM_MS,
  },
) {
  const graceTimers = new Set();
  // stop() aborts every answer still streaming, and every nudge the AI is still
  // thinking about, so none outlives the handlers.
  const answers = new AbortController();
  // Answers still streaming: stop() waits until each one it aborted has posted ai:failed.
  const streaming = new Set();
  let stopped = false;

  async function loadMeetingMeta(meetingId) {
    const live = await store.getMeta(meetingId);
    // initMeta on a room that exists only renews its age, so the idle sweep can't
    // clear it between here and the join script. False: it ended meanwhile; the
    // database below says so.
    if (live && (await store.initMeta(meetingId, live))) return live;
    const { rows } = await db.query(
      `SELECT host_id, admission, screen_share_policy, max_participants, mode, ai_enabled, ai_nudges, ended_at
       FROM meetings WHERE id = $1`,
      [meetingId],
    );
    if (rows.length === 0) return null;
    if (rows[0].ended_at) return { ended: true };
    const meta = {
      hostId: rows[0].host_id,
      admission: rows[0].admission,
      screenSharePolicy: rows[0].screen_share_policy,
      maxParticipants: rows[0].max_participants,
      mode: rows[0].mode,
      aiEnabled: rows[0].ai_enabled,
      aiNudges: rows[0].ai_nudges,
    };
    // Refused for an hour after the meeting ended: a join that read the row just
    // before "End for all" committed must not bring the room back.
    if (!(await store.initMeta(meetingId, meta))) return { ended: true };
    return meta;
  }

  async function isRemoved(meetingId, userId) {
    const { rows } = await db.query(
      'SELECT removed_at FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
      [meetingId, userId],
    );
    return rows.length > 0 && rows[0].removed_at !== null;
  }

  async function userInfo(userId) {
    const { rows } = await db.query('SELECT name, image_url FROM users WHERE id = $1', [userId]);
    return { name: rows[0]?.name ?? 'Someone', imageUrl: rows[0]?.image_url ?? null };
  }

  const markStarted = (meetingId) =>
    db.query('UPDATE meetings SET started_at = COALESCE(started_at, now()) WHERE id = $1', [meetingId]);

  // Only a meeting that actually started can end, so a lobby that empties out
  // before anyone was admitted never gets a bogus ended_at. Every end comes through
  // here, and only the call that ended it logs "meeting ended" (reason: host | empty |
  // idle | stale).
  async function markEnded(meetingId, reason) {
    const result = await db.query(
      'UPDATE meetings SET ended_at = now() WHERE id = $1 AND started_at IS NOT NULL AND ended_at IS NULL',
      [meetingId],
    );
    if (result.rowCount > 0) log.info('meeting ended', { meetingId, reason });
    return result;
  }

  const upsertParticipant = (meetingId, userId, isHostUser) =>
    db.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [meetingId, userId, isHostUser ? 'host' : 'participant'],
    );

  // Asks as little as it can: a socket of ours is in this process, a server whose
  // heartbeat lapsed has none, and only a live other server is asked over the adapter.
  // That ask can time out (the adapter counts a dead server until its connection
  // drops); then we can't tell, and treat it as connected: a tab that is gone is
  // released by its own disconnect, or by the sweep, but a wrong "gone" loses a waiter.
  const isConnected = async (socketId, serverId) => {
    if (serverId === store.serverId) return io.sockets.sockets.has(socketId);
    if (!(await store.isServerAlive(serverId))) return false;
    try {
      return (await io.in(socketId).fetchSockets()).length > 0;
    } catch {
      return true;
    }
  };

  // Every seat release goes through here, so none can forget LiveKit: the seat is
  // the only thing that authorizes media. socketId: release only if that socket
  // still holds the seat; null for the host acting on someone.
  async function freeSeat(meetingId, userId, socketId = null) {
    const released = await store.releaseSeat(meetingId, userId, socketId);
    if (released) livekit?.evict(meetingId, userId); // never rejects
    return released;
  }

  async function presenceOf(meetingId) {
    return (await store.listSeats(meetingId)).map(({ userId, name, imageUrl, isHost, lang }) => ({
      userId,
      name,
      imageUrl,
      isHost,
      lang: lang ?? null,
    }));
  }

  // exceptSocketId: someone who was just sent the roster by admit() and needs no second copy.
  async function broadcastPresence(meetingId, exceptSocketId = null) {
    const people = await presenceOf(meetingId);
    io.to(roomChannel(meetingId)).except(exceptSocketId ?? []).emit('room:presence', { people });
  }

  // One call refreshes both sides of the lobby: the host's list, and every waiting
  // person's position.
  async function broadcastLobby(meetingId) {
    const [meta, waiting, seated] = await Promise.all([
      store.getMeta(meetingId),
      store.queuedEntries(meetingId),
      store.listSeats(meetingId),
    ]);
    const host = seated.find((seat) => seat.isHost);
    if (host) {
      io.to(host.socketId).emit('lobby:update', {
        waiting: waiting.map(({ userId, name, imageUrl }) => ({ userId, name, imageUrl })),
      });
    }
    waiting.forEach((entry, index) => {
      io.to(entry.socketId).emit('meeting:waiting', { position: index + 1, manual: meta?.admission === 'manual' });
    });
  }

  // The one place the room hears who is presenting.
  async function broadcastScreen(meetingId) {
    const sharer = await store.screenSharer(meetingId);
    io.to(roomChannel(meetingId)).emit('screen:state', { sharerUserId: sharer?.userId ?? null });
  }

  // Ends a share if `holderSocketId` holds the lock: release (one script, so a
  // request racing this sees it gone), revoke at LiveKit, tell the room.
  async function releaseScreen(meetingId, holderSocketId) {
    const released = await store.releaseScreenLock(meetingId, holderSocketId);
    if (!released) return;
    livekit?.revokeScreenShare(meetingId, released.userId);
    await broadcastScreen(meetingId);
  }

  // Runs the admission side effects for a socket that already holds its seat, on
  // whichever server it lives. Room-wide presence and lobby broadcasts are the caller's.
  async function admit(socketId, meetingId, userId, isHostUser, replacedSocketId) {
    // A share belongs to the page that started it: a newer page taking this seat
    // ends the old page's share, and never inherits it.
    if (replacedSocketId) await releaseScreen(meetingId, replacedSocketId);
    await upsertParticipant(meetingId, userId, isHostUser);
    await markStarted(meetingId);
    if (replacedSocketId) {
      io.in(replacedSocketId).socketsLeave(roomChannel(meetingId));
      io.to(replacedSocketId).emit('meeting:replaced');
    }
    io.in(socketId).socketsJoin(roomChannel(meetingId));
    // Read first, then send all four back to back: the client holds the roster and
    // who is presenting by the time it has handled "admitted", as it did when this
    // all lived in one process. Straight to this socket: on another server the room
    // join above can land after the caller's room-wide broadcast. The settings come
    // first: the host may have changed one since this person loaded the meeting card
    // (pre-join, lobby, reconnect), and the page would keep the old value.
    const [people, sharer, meta] = await Promise.all([presenceOf(meetingId), store.screenSharer(meetingId), store.getMeta(meetingId)]);
    if (meta) io.to(socketId).emit('meeting:settings', settingsOf(meta));
    io.to(socketId).emit('meeting:admitted');
    io.to(socketId).emit('room:presence', { people });
    io.to(socketId).emit('screen:state', { sharerUserId: sharer?.userId ?? null });
  }

  // drainQueue already took the seat; a tab that closed meanwhile hands it straight back.
  async function admitDrained(entry, meetingId) {
    if (!(await isConnected(entry.socketId, entry.serverId))) {
      await freeSeat(meetingId, entry.userId, entry.socketId);
      return;
    }
    await admit(entry.socketId, meetingId, entry.userId, false, null);
  }

  // Seats everyone the lobby has room for (nobody while admission is manual). A seat
  // handed back by a closed tab is offered again, so it is asked until a round seats no
  // one. Resolves to whether anyone was seated.
  async function drainLobby(meetingId) {
    let seated = false;
    for (;;) {
      const drained = await store.drainQueue(meetingId);
      if (drained.length === 0) return seated;
      seated = true;
      for (const entry of drained) await admitDrained(entry, meetingId);
    }
  }

  async function onSeatFreed(meetingId) {
    if (!(await store.getMeta(meetingId))) return;
    await drainLobby(meetingId);
    await broadcastPresence(meetingId);
    await broadcastScreen(meetingId); // a released seat drops the lock with it
    await broadcastLobby(meetingId);
    if ((await store.listSeats(meetingId)).length > 0) return;
    await endEmptyRoom(meetingId);
  }

  // Nobody is seated any more, so the meeting is over. Whoever the clear drops, a
  // lobby waiter or a join seated in the gap just before it, is told rather than left spinning.
  async function endEmptyRoom(meetingId) {
    const { rowCount } = await markEnded(meetingId, 'empty');
    for (const id of await store.clearMeeting(meetingId, { ended: rowCount > 0 })) {
      io.to(id).emit('meeting:denied', { reason: 'ended' });
    }
    await forget(meetingId);
  }

  // A history failure is logged and never holds up the chat or an answer.
  const remember = (meetingId, entry) =>
    history.add(meetingId, entry).catch((err) => log.error('chat history failed', { meetingId, err: err.message }));

  // The same for clearing: a Redis failure here must not skip a disconnect, abort the
  // sweep's Postgres pass, or be logged as a failed handler.
  const forget = (meetingId) =>
    history.clear(meetingId).catch((err) => log.error('chat history clear failed', { meetingId, err: err.message }));

  // A nudge signal (lastVoiceAt, lastChatAt) restarts the meeting's quiet clock. A failed
  // write is logged once per outage and never holds up chat.
  let signalFailing = false;
  async function touch(meetingId, field) {
    try {
      await store.touch(meetingId, field);
      signalFailing = false;
    } catch (err) {
      if (!signalFailing) log.error('nudge signal failed', { meetingId, err: err.message });
      signalFailing = true;
    }
  }

  // Every person's ZyloChat line goes out through here, so the AI's history never misses
  // one and each one restarts the quiet clock. Answers and nudges don't come this way.
  async function relayChat(meetingId, message) {
    io.to(roomChannel(meetingId)).emit('chat:message', { ...message, ts: Date.now() });
    await remember(meetingId, { name: message.name, text: message.text });
    await touch(meetingId, 'lastChatAt');
  }

  // Streams one answer to the whole room, on whichever servers its people are. ai:done
  // carries the full text, so a client that missed a piece still ends with the right
  // answer. Any failure is ai:failed and stays out of the history: never a fake reply.
  async function answer(meetingId, askedBy, messages) {
    const id = randomUUID();
    const toRoom = (event, payload) => io.to(roomChannel(meetingId)).emit(event, payload);
    toRoom('ai:start', { id, askedBy, ts: Date.now() });
    let pending = '';
    let timer = null;
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (pending) toRoom('ai:chunk', { id, delta: pending });
      pending = '';
    };
    let text;
    try {
      text = await ai.stream({
        messages,
        signal: answers.signal,
        onDelta: (delta) => {
          pending += delta;
          timer ??= setTimeout(flush, AI_CHUNK_MS);
        },
      });
    } catch (err) {
      clearTimeout(timer);
      log.error('AI answer failed', { meetingId, userId: askedBy.userId, err: err.message });
      return toRoom('ai:failed', { id, message: AI_FAILED });
    }
    flush(); // the chunks always add up to the full text
    toRoom('ai:done', { id, text, ts: Date.now() });
    // ponytail: an answer that finishes after its meeting ended writes this one line
    // back; the key's 6 h TTL removes it. Check the room first if that ever matters.
    await remember(meetingId, { name: AI_NAME, text, ai: true });
  }

  // Nudges are effectively on: the host's setting, AI in chat, an AI client on this
  // server, and not a Translator Convo. Otherwise nothing is checked beyond the meta.
  const nudgesOn = (meta) => Boolean(ai && meta && meta.aiNudges && meta.aiEnabled && meta.mode !== 'translator');

  // One nudge: claim it (one server, once per 90 s per meeting), spend the deployment's
  // budget, ask the AI with the last 20 chat lines, re-check, then post. Never a canned
  // line: silence, an empty answer or any failure posts nothing.
  async function nudge(meetingId, reason) {
    if (!(await store.claimNudge(meetingId))) return; // another server has it, or the cooldown runs
    if (reason === 'quiet') await store.setMetaField(meetingId, 'quietNudged', '1'); // one claim per quiet stretch
    if (!(await limiter.take('aiNudgeAll', 'all')).allowed) return;
    const answer = await ai.stream({
      messages: promptFor(await history.recent(meetingId)),
      system: NUDGE_PROMPT(reason),
      maxTokens: NUDGE_MAX_TOKENS,
      signal: answers.signal,
    });
    const text = nudgeText(answer);
    if (!text) return;
    // The meeting may have ended, or the host switched nudges or AI off, while it thought.
    if (!nudgesOn(await store.getMeta(meetingId))) return;
    io.to(roomChannel(meetingId)).emit('ai:nudge', { id: randomUUID(), text, reason, ts: Date.now() });
    await remember(meetingId, { name: AI_NAME, text, ai: true });
  }

  // Runs a nudge without making the caller (the chat handler, the sweep) wait for the
  // provider; failures are logged on the server only.
  const fire = (meetingId, reason) =>
    nudge(meetingId, reason).catch((err) => log.error('AI nudge failed', { meetingId, err: err.message }));

  // The chat triggers, after a person's line was relayed and remembered (never an Ask AI
  // line: the AI is already answering that one). A stuck phrase wins over circles.
  async function checkChat(meetingId, text) {
    if (!nudgesOn(await store.getMeta(meetingId))) return;
    let reason = stuckPhrase(text) ? 'stuck' : null;
    if (!reason) {
      const lines = (await history.recent(meetingId)).filter((entry) => !entry.ai).map((entry) => entry.text);
      if (goingInCircles(lines)) reason = 'circles';
    }
    if (reason) fire(meetingId, reason);
  }

  // The quiet check, for each live meeting on every sweep: the meta first, the seats
  // and the history only when it passes. A failure is logged and never stops the sweep.
  async function checkQuiet(meetingId, meta) {
    try {
      const now = Date.now();
      if (!nudgesOn(meta) || !quietLongEnough(meta, now)) return;
      const [seats, lines] = await Promise.all([store.listSeats(meetingId), history.recent(meetingId)]);
      if (isQuiet(meta, now, seats.length, lines.filter((entry) => !entry.ai).length)) fire(meetingId, 'quiet');
    } catch (err) {
      log.error('quiet check failed', { meetingId, err: err.message });
    }
  }

  // Every host-only event runs through this. Authorization is a server check:
  // whether the client renders the button is irrelevant. The host's seat must be
  // held by this very socket: a replaced tab keeps a stale meetingId.
  async function hostGuard(socket) {
    if (!allowEvent(socket, 'host')) {
      socket.emit('rate-limited', { event: 'host' });
      return null;
    }
    const { meetingId, userId } = socket.data;
    const meta = meetingId ? await store.getMeta(meetingId) : null;
    const seat = meta && meta.hostId === userId ? await store.seatFor(meetingId, userId) : null;
    if (!seat || seat.socketId !== socket.id) {
      socket.emit('error:forbidden');
      return null;
    }
    return { meetingId, meta };
  }

  // Started only after markGrace resolved, so it can't fire before the deadline
  // Redis stamped. Does nothing if the person came back on any server.
  function startGraceTimer(meetingId, userId, socketId) {
    if (stopped) return;
    const timer = setTimeout(() => {
      graceTimers.delete(timer);
      expireGrace(meetingId, userId, socketId).catch((err) =>
        log.error('seat release failed', { meetingId, userId, err: err.message }),
      );
    }, graceMs);
    timer.unref(); // a held seat must never keep the process alive
    graceTimers.add(timer);
  }

  async function expireGrace(meetingId, userId, socketId) {
    if (!(await store.releaseIfStale(meetingId, userId, socketId))) return;
    livekit?.evict(meetingId, userId);
    await onSeatFreed(meetingId);
  }

  // Socket.IO does not catch rejections from async handlers, and one unhandled
  // rejection would take the process down. One wrapper covers every handler, and counts
  // the ones still running, so a planned stop can wait for them (drain).
  let running = 0;
  const idle = new EventEmitter();
  const on = (socket, event, handler) =>
    socket.on(event, (...args) => {
      running += 1;
      Promise.resolve()
        .then(() => handler(...args))
        .catch((err) => {
          const { meetingId, userId } = socket.data;
          log.error(`socket ${event} failed`, { event, meetingId, userId, err: err.message });
        })
        .finally(() => {
          running -= 1;
          if (running === 0) idle.emit('idle');
        });
    });

  // Resolves true once no socket handler is running, or false if some still are after ms.
  const drain = (ms) =>
    running === 0
      ? Promise.resolve(true)
      : once(idle, 'idle', { signal: AbortSignal.timeout(ms) }).then(() => true, () => false);

  // Crash recovery, run by every server every sweepMs. Each step is a script that
  // checks before it changes anything, so servers sweeping at once is harmless.
  // ponytail: walks every live meeting with a few round trips each; fine for hundreds
  // of rooms. Split the live set per server if that ever stops being true.
  async function sweep() {
    const alive = new Map();
    // Gone: its server's heartbeat stopped, or it is ours and not connected here.
    const gone = async ({ serverId, socketId }) => {
      if (serverId === store.serverId) return !io.sockets.sockets.has(socketId);
      if (!alive.has(serverId)) alive.set(serverId, await store.isServerAlive(serverId));
      return !alive.get(serverId);
    };
    // One room failing must not skip the rest: keep going, then report the first error.
    let failure = null;
    for (const meetingId of await store.liveMeetings()) {
      try {
        const meta = await store.getMeta(meetingId);
        if (!meta) {
          await store.forgetLive(meetingId);
          continue;
        }
        await checkQuiet(meetingId, meta);
        let seatFreed = false;
        let lobbyChanged = false;
        for (const seat of await store.listSeats(meetingId)) {
          if (seat.graceUntil) {
            if (seat.serverId === store.serverId && io.sockets.sockets.has(seat.socketId)) {
              // Stamped by another server while our heartbeat had lapsed; we're still here.
              await store.keepSeat(meetingId, seat.userId, seat.socketId);
            } else if (await store.releaseIfStale(meetingId, seat.userId, seat.socketId)) {
              livekit?.evict(meetingId, seat.userId);
              seatFreed = true;
            }
          } else if (await gone(seat)) {
            // Released on a later sweep, unless they come back first.
            await store.markGrace(meetingId, seat.userId, seat.socketId, graceMs);
          }
        }
        const queued = await store.queuedEntries(meetingId);
        for (const entry of queued) {
          if ((await gone(entry)) && (await store.removeFromQueue(meetingId, entry.userId, entry.socketId))) lobbyChanged = true;
        }
        const sharer = await store.screenSharer(meetingId);
        if (sharer && (await gone(sharer))) await releaseScreen(meetingId, sharer.socketId);
        // Anyone still waiting is offered a seat on every pass, not only the one that freed
        // one: an earlier drain may have failed halfway. One script call, and it seats no
        // one when there is nothing to do (or admission is manual).
        const seated = queued.length > 0 && (await drainLobby(meetingId));
        if (seatFreed || seated) await onSeatFreed(meetingId);
        else if (lobbyChanged) await broadcastLobby(meetingId);
        else if (await store.clearIfIdle(meetingId, idleRoomMs)) {
          await markEnded(meetingId, 'idle');
          await forget(meetingId);
        }
      } catch (err) {
        failure ??= err;
      }
    }
    // Live in Postgres but held by no server: a crash, or Redis lost its data.
    try {
      const { rows } = await db.query('SELECT id FROM meetings WHERE started_at IS NOT NULL AND ended_at IS NULL');
      const live = new Set(rows.length > 0 ? await store.liveMeetings() : []);
      for (const { id } of rows) {
        if (live.has(id)) continue;
        // Its code may only have dropped out of the live set: put it back, don't end it.
        if (await store.getMeta(id)) {
          await store.markLive(id);
          continue;
        }
        // Ended as "End for all" does: the row, then whoever is still in the room, the
        // tombstone that refuses a rejoin, and LiveKit. Only the server that changed the
        // row does the rest, so two sweeps don't both do it.
        const { rowCount } = await markEnded(id, 'stale');
        if (rowCount === 0) continue;
        io.to(roomChannel(id)).emit('meeting:ended');
        await store.clearMeeting(id, { ended: true });
        livekit?.endRoom(id); // never rejects
        await forget(id);
      }
    } catch (err) {
      failure ??= err;
    }
    if (failure) throw failure;
  }

  let sweeping = false;
  let sweepFailing = false;
  async function runSweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      await sweep();
      sweepFailing = false;
    } catch (err) {
      if (!sweepFailing) log.error('room sweep failed', { err: err.message }); // once per outage
      sweepFailing = true;
    } finally {
      sweeping = false;
    }
  }

  // Redis being down is already logged once by redis.js; a missed beat just retries.
  const beat = () => store.beat().catch(() => {});
  const timers = [];
  if (sweepMs > 0) {
    beat();
    timers.push(setInterval(beat, HEARTBEAT_MS), setInterval(runSweep, sweepMs));
    timers.forEach((timer) => timer.unref());
  }

  async function joinMeeting(socket, meetingId, lang) {
    const meta = await loadMeetingMeta(meetingId);
    if (!meta) return socket.emit('meeting:denied', { reason: 'not_found' });
    if (meta.ended) return socket.emit('meeting:denied', { reason: 'ended' });

    const { userId } = socket.data;
    if (await isRemoved(meetingId, userId)) return socket.emit('meeting:denied', { reason: 'removed' });

    const isHostUser = meta.hostId === userId;
    const { name, imageUrl } = await userInfo(userId);
    // lang only means anything in a translator convo, and only if it is one of
    // the supported codes; anything else silently becomes null, like chat.
    const seatLang = meta.mode === 'translator' && isConvoLang(lang) ? lang : null;
    // One script decides the rest atomically: removed or ended while we awaited,
    // a reconnect taking its own seat back, the manual lobby, the host's reserved
    // seat, a full translator convo, a full room's lobby.
    const outcome = await store.join(
      meetingId,
      { userId, socketId: socket.id, name, imageUrl, lang: seatLang },
      { isHost: isHostUser },
    );
    if (outcome.result === 'ended' || outcome.result === 'removed' || outcome.result === 'full') {
      return socket.emit('meeting:denied', { reason: outcome.result });
    }
    socket.data.meetingId = meetingId;
    if (outcome.result === 'queued') return broadcastLobby(meetingId);
    await admit(socket.id, meetingId, userId, isHostUser, outcome.replacedSocketId);
    await broadcastPresence(meetingId, socket.id);
    // A host arriving needs to see whoever is already waiting for them.
    if (isHostUser) await broadcastLobby(meetingId);
  }

  io.on('connection', (socket) => {
    on(socket, 'meeting:join-request', async ({ meetingId, lang } = {}) => {
      if (!allowEvent(socket, 'meeting:join-request')) return socket.emit('rate-limited', { event: 'meeting:join-request' });
      if (typeof meetingId !== 'string') return socket.emit('meeting:denied', { reason: 'not_found' });
      try {
        await joinMeeting(socket, meetingId, lang);
      } catch (err) {
        // The store or the database can't be read: never admit anyone blind.
        // meetingId is the client's own text (up to about 1 MB, newlines too): logged only
        // when it is a real meeting code, so an outage can't be used to write into the log.
        log.error('join failed', {
          meetingId: isValidCode(meetingId) ? meetingId : undefined,
          userId: socket.data.userId,
          err: err.message,
        });
        socket.emit('meeting:denied', { reason: 'unavailable' });
      }
    });

    // Translator convos only, and only through the seat this socket holds.
    on(socket, 'convo:set-lang', async ({ lang } = {}) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'convo:set-lang')) return;
      if (!isConvoLang(lang)) return;
      const meta = await store.getMeta(meetingId);
      if (!meta || meta.mode !== 'translator') return;
      if (!(await store.setSeatLang(meetingId, userId, socket.id, lang))) return;
      await broadcastPresence(meetingId);
    });

    // Translator convos only. Identity comes from the seat, never the payload.
    // socket.to (not io.to) excludes the sender, which already rendered its own caption.
    on(socket, 'convo:caption', async (payload) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      // Captions are chatty (interim results, client-throttled to ~4/s); extras past
      // the bucket are dropped silently, since the next interim replaces them anyway.
      // Before any store read, so a socket that may not caption costs Redis nothing
      // beyond the burst.
      if (!allowEvent(socket, 'convo:caption')) return;
      const [seat, meta] = await Promise.all([store.seatFor(meetingId, userId), store.getMeta(meetingId)]);
      if (!seat || seat.socketId !== socket.id) return;
      if (!meta || meta.mode !== 'translator') return;
      const clean = validateCaption(payload);
      if (!clean) return;
      socket.to(roomChannel(meetingId)).emit('convo:caption', { userId, name: seat.name, ...clean, ts: Date.now() });
    });

    on(socket, 'meeting:leave', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return socket.disconnect(true);
      // Only what this socket owns: a replaced tab's leave must not free the new tab's seat.
      const dequeued = await store.removeFromQueue(meetingId, userId, socket.id);
      const freed = await freeSeat(meetingId, userId, socket.id);
      socket.leave(roomChannel(meetingId));
      socket.data.meetingId = null;
      // A waiter leaving frees no seat: the room is not empty, only the lobby changed.
      if (freed) await onSeatFreed(meetingId);
      else if (dequeued) await broadcastLobby(meetingId);
      socket.disconnect(true);
    });

    // ZyloChat. The name comes from the seat, never the payload.
    on(socket, 'chat:message', async ({ text } = {}) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'chat:message')) return socket.emit('rate-limited', { event: 'chat:message' });
      const seat = await store.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return;
      const clean = validateChatText(text);
      if (!clean) return;
      await relayChat(meetingId, { userId, name: seat.name, text: clean });
      await checkChat(meetingId, clean);
    });

    // "I spoke just now" from a browser, about its own person (no audio, no text): the
    // quiet clock restarts. Background traffic, so it is refused without a notice.
    on(socket, 'voice:activity', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'voice:activity')) return;
      const [seat, meta] = await Promise.all([store.seatFor(meetingId, userId), store.getMeta(meetingId)]);
      if (!seat || seat.socketId !== socket.id) return;
      if (!meta || meta.mode === 'translator') return;
      await touch(meetingId, 'lastVoiceAt');
    });

    // Zylo AI. The checks run in the spec's order: the shared per-user limit before any
    // store read (a flood costs one Redis call each), the chat rule, the seat, the
    // meeting's setting, then the per-meeting limit that bounds the cost.
    on(socket, 'ai:ask', async ({ text } = {}) => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!(await limiter.take('aiUser', userId)).allowed) return socket.emit('rate-limited', { event: 'ai:ask' });
      const clean = validateChatText(text);
      if (!clean) return;
      const seat = await store.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return;
      const meta = await store.getMeta(meetingId);
      if (!meta || meta.mode === 'translator') return;
      if (!meta.aiEnabled) return socket.emit('ai:error', { reason: 'disabled' });
      if (!ai) return socket.emit('ai:error', { reason: 'not_configured' });
      if (!(await limiter.take('aiRoom', meetingId)).allowed) return socket.emit('rate-limited', { event: 'ai:ask' });
      // Read before the question joins it: the AI gets the 20 lines before it, then the
      // question. A failed read drops the question before anything is posted.
      const earlier = await history.recent(meetingId);
      const askedBy = { userId, name: seat.name };
      await relayChat(meetingId, { ...askedBy, text: clean, toAi: true });
      const answering = answer(meetingId, askedBy, promptFor(earlier, { name: seat.name, text: clean }));
      streaming.add(answering);
      await answering.finally(() => streaming.delete(answering));
    });

    // ZyloLive. The lock script re-checks the seat and the host-only policy, so two
    // people pressing ZyloLive together (on any servers) cannot both win.
    on(socket, 'screen:request', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      if (!allowEvent(socket, 'screen:request')) return socket.emit('rate-limited', { event: 'screen:request' });
      const seat = await store.seatFor(meetingId, userId);
      if (!seat || seat.socketId !== socket.id) return; // lobby or replaced tab: ignored, like chat
      if (!livekit) return socket.emit('screen:denied', { reason: 'unavailable' });
      const lock = await store.takeScreenLock(meetingId, { userId, socketId: socket.id });
      if (lock.reason === 'noseat') return;
      if (lock.reason === 'host_only') return socket.emit('screen:denied', { reason: 'host_only' });
      if (!lock.ok) {
        const sharerName = (await store.seatFor(meetingId, lock.sharerUserId))?.name ?? 'someone';
        return socket.emit('screen:denied', { reason: 'busy', sharerName });
      }
      try {
        await livekit.grantScreenShare(meetingId, userId);
      } catch (err) {
        log.error('screen share grant failed', { meetingId, userId, err: err.message });
        await store.releaseScreenLock(meetingId, socket.id);
        livekit.revokeScreenShare(meetingId, userId); // never rejects; the grant may have applied
        return socket.emit('screen:denied', { reason: 'unavailable' });
      }
      // The lock can be released while the grant is in flight (host stop, policy
      // switch, this tab closing). Revoke again rather than leave a permission with no lock.
      if ((await store.screenSharer(meetingId))?.socketId !== socket.id) {
        livekit.revokeScreenShare(meetingId, userId);
        return;
      }
      socket.emit('screen:granted');
      await broadcastScreen(meetingId);
    });

    on(socket, 'screen:stop', async () => {
      const { meetingId } = socket.data;
      if (meetingId) await releaseScreen(meetingId, socket.id); // only the holder's socket releases
    });

    on(socket, 'lobby:admit', async ({ userId } = {}, ack) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      if (typeof userId !== 'string') return ack?.({ ok: false, reason: 'gone' });
      // One script: still waiting, a seat free, then seated and out of the lobby.
      const outcome = await store.admitFromQueue(meetingId, userId);
      if (outcome.result === 'gone') return ack?.({ ok: false, reason: 'gone' });
      // Full: the host is told, and the person keeps their place in the lobby.
      if (outcome.result === 'full') return ack?.({ ok: false, reason: 'full' });
      if (!(await isConnected(outcome.entry.socketId, outcome.entry.serverId))) {
        await freeSeat(meetingId, userId, outcome.entry.socketId);
        await onSeatFreed(meetingId); // the seat goes to the next in the lobby if admission is auto
        return ack?.({ ok: false, reason: 'gone' });
      }
      await admit(outcome.entry.socketId, meetingId, userId, false, null);
      ack?.({ ok: true });
      await broadcastPresence(meetingId);
      await broadcastLobby(meetingId);
    });

    on(socket, 'lobby:deny', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      if (typeof userId !== 'string') return;
      const socketId = await store.queueSocketId(meetingId, userId);
      if (!socketId || !(await store.removeFromQueue(meetingId, userId, socketId))) return;
      io.to(socketId).emit('meeting:denied', { reason: 'denied' });
      await broadcastLobby(meetingId);
    });

    on(socket, 'host:set-admission', async ({ mode } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      // A translator convo is always auto admission: a silent no-op.
      if (meta.mode === 'translator') return;
      // A malformed payload from an authenticated host is a client bug: ignore it.
      if (mode !== 'auto' && mode !== 'manual') return;
      await store.setMetaField(meetingId, 'admission', mode);
      await db.query('UPDATE meetings SET admission = $1 WHERE id = $2', [mode, meetingId]);
      io.to(roomChannel(meetingId)).emit('meeting:settings', settingsOf({ ...meta, admission: mode }));
      if (mode === 'auto') {
        await drainLobby(meetingId);
        await broadcastPresence(meetingId);
      }
      await broadcastLobby(meetingId);
    });

    on(socket, 'host:set-screen-policy', async ({ policy } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (policy !== 'anyone' && policy !== 'host_only') return; // client bug; see host:set-admission
      // Written first: the lock script checks the policy, so no participant can take
      // the lock after this line, and one who took it just before loses it below.
      await store.setMetaField(meetingId, 'screenSharePolicy', policy);
      const sharer = await store.screenSharer(meetingId);
      if (policy === 'host_only' && sharer && sharer.userId !== meta.hostId) await releaseScreen(meetingId, sharer.socketId);
      io.to(roomChannel(meetingId)).emit('meeting:settings', settingsOf({ ...meta, screenSharePolicy: policy }));
      await db.query('UPDATE meetings SET screen_share_policy = $1 WHERE id = $2', [policy, meetingId]);
    });

    // AI in chat. An answer already streaming finishes; new questions are refused.
    // Turning it back on also turns nudges back on if the host left them on, and browsers
    // stop reporting speech while AI is off, so the quiet clock restarts first (as in
    // host:set-nudges) rather than nudging a meeting that was talking all along.
    on(socket, 'host:set-ai', async ({ enabled } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (typeof enabled !== 'boolean') return; // client bug; see host:set-admission
      if (meta.mode === 'translator') return; // no Ask AI in a translator convo: a silent no-op
      if (enabled) await store.setMetaField(meetingId, 'nudgesOnAt', Date.now());
      await store.setMetaField(meetingId, 'aiEnabled', enabled ? '1' : '0');
      await db.query('UPDATE meetings SET ai_enabled = $1 WHERE id = $2', [enabled, meetingId]);
      io.to(roomChannel(meetingId)).emit('meeting:settings', settingsOf({ ...meta, aiEnabled: enabled }));
    });

    // AI nudges. Switching on restarts the quiet clock first, so a meeting that has been
    // quiet for ten minutes isn't nudged the moment the host turns this on.
    on(socket, 'host:set-nudges', async ({ enabled } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (typeof enabled !== 'boolean') return; // client bug; see host:set-admission
      if (meta.mode === 'translator') return; // no nudges in a translator convo: a silent no-op
      if (enabled) await store.setMetaField(meetingId, 'nudgesOnAt', Date.now());
      await store.setMetaField(meetingId, 'aiNudges', enabled ? '1' : '0');
      await db.query('UPDATE meetings SET ai_nudges = $1 WHERE id = $2', [enabled, meetingId]);
      io.to(roomChannel(meetingId)).emit('meeting:settings', settingsOf({ ...meta, aiNudges: enabled }));
    });

    on(socket, 'host:stop-share', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      // Named, not "whoever is sharing": a click aimed at Priya's share must not end
      // Raj's if the lock changed hands while the menu was open.
      const sharer = await store.screenSharer(guard.meetingId);
      if (sharer && sharer.userId === userId) await releaseScreen(guard.meetingId, sharer.socketId);
    });

    on(socket, 'host:mute', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      if (typeof userId !== 'string' || !(await store.hasSeat(guard.meetingId, userId))) return;
      livekit?.muteMic(guard.meetingId, userId); // never rejects; they can unmute themselves
    });

    on(socket, 'host:kick', async ({ userId } = {}) => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId, meta } = guard;
      if (typeof userId !== 'string' || userId === meta.hostId) return;
      // In the store before the DB await below: the join script checks this set, so a
      // join already past its own isRemoved check can't seat them after this line.
      await store.addRemoved(meetingId, userId);
      // The DB next: once this commits, a rejoin (isRemoved) and a token request are
      // refused, and it survives a restart.
      const { rowCount } = await db.query(
        `UPDATE meeting_participants SET removed_at = now()
         WHERE meeting_id = $1 AND user_id = $2 AND removed_at IS NULL`,
        [meetingId, userId],
      );
      const seat = await store.seatFor(meetingId, userId);
      const queuedSocketId = await store.queueSocketId(meetingId, userId);
      if (rowCount === 0 && !seat && !queuedSocketId) return;
      await store.removeFromQueue(meetingId, userId);
      for (const id of new Set([seat?.socketId, queuedSocketId])) {
        if (!id) continue;
        io.in(id).socketsLeave(roomChannel(meetingId));
        // Before LiveKit hears anything, so the client tears media down on its
        // "removed" screen instead of first seeing a media error.
        io.to(id).emit('meeting:removed');
      }
      if (seat) await freeSeat(meetingId, userId); // evicts; drops the lock
      await onSeatFreed(meetingId);
    });

    on(socket, 'host:end-meeting', async () => {
      const guard = await hostGuard(socket);
      if (!guard) return;
      const { meetingId } = guard;
      // The DB first, so from the moment anyone is told, a rejoin reads ended_at and
      // is refused, and the meeting is already in everyone's Previous list.
      await markEnded(meetingId, 'host');
      const socketIds = await store.clearMeeting(meetingId, { ended: true });
      for (const id of socketIds) {
        io.in(id).socketsLeave(roomChannel(meetingId));
        io.to(id).emit('meeting:ended');
      }
      livekit?.endRoom(meetingId); // after the sockets, as in host:kick; never rejects
      await forget(meetingId);
    });

    on(socket, 'disconnect', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return;
      // A share never outlives the page that started it.
      await releaseScreen(meetingId, socket.id);
      // A newer connection may hold this lobby entry or seat (two tabs): only ours.
      if (await store.removeFromQueue(meetingId, userId, socket.id)) await broadcastLobby(meetingId);
      if (!(await store.markGrace(meetingId, userId, socket.id, graceMs))) return;
      startGraceTimer(meetingId, userId, socket.id);
    });
  });

  return {
    sweep: runSweep,
    drain,
    // Cancels timers, pending grace periods, and answers and nudges still running, and
    // starts no new timers (tests, and the planned stop in shutdown.js). Resolves once
    // every answer it cut short has posted ai:failed to its room.
    stop() {
      stopped = true;
      answers.abort();
      timers.forEach((timer) => clearInterval(timer));
      for (const timer of graceTimers) clearTimeout(timer);
      graceTimers.clear();
      return Promise.allSettled(streaming);
    },
  };
}

module.exports = { registerRoomHandlers, roomChannel };
