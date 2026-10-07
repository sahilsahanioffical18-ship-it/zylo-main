// Live room state in Redis, so every API server sees the same rooms: seats, the
// lobby, the screen-share lock, the live meeting settings and who was removed.
// Each check-and-change is one Lua script. Redis runs a script without letting any
// other command in, which is what keeps the last seat, the lobby order and the
// screen-share lock race-safe across servers (the job "no await between the check
// and the write" did when this lived in one process's memory).
// What a caller reads before calling a script can be stale by the time it runs, so
// a script re-checks what it depends on: drainQueue reads the admission mode itself,
// join keeps a newcomer behind anyone already waiting (a freed seat and the lobby
// advancing are two calls), and initMeta renews the room's age for the idle sweep.
//
// Keys per meeting. The {code} braces are a Redis Cluster hash tag: all of one
// meeting's keys land together, so one script may touch them all.
//   zylo:room:{code}:meta     hash   hostId, admission, screenSharePolicy, maxParticipants, mode, aiEnabled ('1'|'0'), since (renewed by every initMeta),
//                                    aiNudges ('1'|'0'), and the nudge signals nudgesOnAt, lastVoiceAt, lastChatAt (ms, the writing
//                                    server's Date.now(), not Redis's clock: the sweep compares them with Date.now()), quietNudged ('1')
//   zylo:room:{code}:seats    hash   userId -> { socketId, serverId, name, imageUrl, isHost, lang, seq, graceUntil? }
//   zylo:room:{code}:queue    hash   userId -> { userId, socketId, serverId, name, imageUrl, lang, seq }
//   zylo:room:{code}:screen   string { userId, socketId, serverId }
//   zylo:room:{code}:removed  set    user ids the host removed
//   zylo:room:{code}:seq      counter that orders seats and lobby entries
//   zylo:room:{code}:ended    tombstone for an hour after the meeting ended
// No TTLs: a room's keys go when it ends, and room.js's sweeper catches leftovers.
// Outside any script: zylo:rooms:live (codes the sweeper walks), zylo:server:<id>, and
// zylo:room:{code}:nudge, the 90 s nudge claim, which simply expires.

const GRACE_MS = 30_000;
// One nudge claim per meeting per this long, whichever server takes it (spec §4).
const NUDGE_CLAIM_MS = 90_000;
const HEARTBEAT_TTL_MS = 30_000;
const LIVE = 'zylo:rooms:live';

function roomKeys(code) {
  const key = (part) => `zylo:room:{${code}}:${part}`;
  return [key('meta'), key('seats'), key('queue'), key('screen'), key('removed'), key('seq'), key('ended')];
}

// Shared by every script. Clock: Redis's own, so servers whose clocks differ agree.
const PRELUDE = `
local META, SEATS, QUEUE, SCREEN, REMOVED, SEQ, ENDED = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7]

local function nowMs()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function getJson(key, field)
  local raw = redis.call('HGET', key, field)
  if raw then return cjson.decode(raw) end
  return nil
end

local function putJson(key, field, value)
  redis.call('HSET', key, field, cjson.encode(value))
end

local function nonHostSeats()
  local n = 0
  for _, raw in ipairs(redis.call('HVALS', SEATS)) do
    if not cjson.decode(raw).isHost then n = n + 1 end
  end
  return n
end

local function sortedQueue()
  local entries = {}
  for _, raw in ipairs(redis.call('HVALS', QUEUE)) do entries[#entries + 1] = cjson.decode(raw) end
  table.sort(entries, function(a, b) return a.seq < b.seq end)
  return entries
end

local function queuePosition(userId)
  for i, e in ipairs(sortedQueue()) do
    if e.userId == userId then return i end
  end
  return nil
end

-- Is anyone besides this user waiting in the lobby?
local function othersQueued(userId)
  local n = redis.call('HLEN', QUEUE)
  if redis.call('HEXISTS', QUEUE, userId) == 1 then n = n - 1 end
  return n > 0
end

-- A retry refreshes the entry in place; it never costs you your position.
local function enqueue(entry)
  local existing = getJson(QUEUE, entry.userId)
  if existing then entry.seq = existing.seq else entry.seq = redis.call('INCR', SEQ) end
  putJson(QUEUE, entry.userId, entry)
  return queuePosition(entry.userId)
end

local function newSeat(entry, isHost)
  return { socketId = entry.socketId, serverId = entry.serverId, name = entry.name, imageUrl = entry.imageUrl,
           isHost = isHost, lang = entry.lang, seq = redis.call('INCR', SEQ) }
end

-- No seat, no share: the lock never outlives the seat that earned it.
local function dropScreenIfHeldBy(userId)
  local raw = redis.call('GET', SCREEN)
  if raw and cjson.decode(raw).userId == userId then redis.call('DEL', SCREEN) end
end
`;

const SCRIPTS = {
  // ARGV: hostId, admission, screenSharePolicy, maxParticipants, mode, aiEnabled ('1'|'0'),
  // aiNudges ('1'|'0'), now (ms; nudges switched on start the quiet clock here). 0 while the
  // ended tombstone exists: a join that read the meeting row just before "End for
  // all" committed must not bring the room back. An existing room keeps its settings
  // but its age restarts, so the idle sweep cannot delete it between this call and
  // the join's seat.
  zyloRoomInitMeta: `
if redis.call('EXISTS', ENDED) == 1 then return 0 end
if redis.call('EXISTS', META) == 0 then
  redis.call('HSET', META, 'hostId', ARGV[1], 'admission', ARGV[2], 'screenSharePolicy', ARGV[3],
    'maxParticipants', ARGV[4], 'mode', ARGV[5], 'aiEnabled', ARGV[6], 'aiNudges', ARGV[7], 'since', tostring(nowMs()))
  if ARGV[7] == '1' then redis.call('HSET', META, 'nudgesOnAt', ARGV[8]) end
else
  redis.call('HSET', META, 'since', tostring(nowMs()))
end
return 1`,

  // ARGV: field, value. Never recreates a room that already ended.
  zyloRoomSetMeta: `
if redis.call('EXISTS', META) == 0 then return 0 end
redis.call('HSET', META, ARGV[1], ARGV[2])
return 1`,

  // ARGV: field (lastVoiceAt | lastChatAt), now (ms). Someone spoke or wrote: stamp it, and
  // a new quiet stretch starts. Never recreates a room that already ended.
  zyloRoomTouch: `
if redis.call('EXISTS', META) == 0 then return 0 end
redis.call('HSET', META, ARGV[1], ARGV[2])
redis.call('HDEL', META, 'quietNudged')
return 1`,

  // ARGV: entry JSON { userId, socketId, serverId, name, imageUrl, lang }, isHost ('1'|'0').
  // Everything the old handler decided after its last await, in one step.
  zyloRoomJoin: `
local entry = cjson.decode(ARGV[1])
local isHost = ARGV[2] == '1'
if redis.call('EXISTS', META) == 0 then return cjson.encode({ result = 'ended' }) end
if redis.call('SISMEMBER', REMOVED, entry.userId) == 1 then return cjson.encode({ result = 'removed' }) end
local meta = redis.call('HMGET', META, 'admission', 'maxParticipants', 'mode')
local admission, max, mode = meta[1], tonumber(meta[2]), meta[3]

-- A reconnect or a second tab: one seat per user. The new socket takes over, keeps
-- the seat's place in the roster, and ends any grace period.
local seat = getJson(SEATS, entry.userId)
if seat then
  local replaced = ''
  if seat.socketId ~= entry.socketId then replaced = seat.socketId end
  seat.socketId = entry.socketId
  seat.serverId = entry.serverId
  seat.name = entry.name
  seat.imageUrl = entry.imageUrl
  seat.lang = entry.lang
  seat.isHost = isHost
  seat.graceUntil = nil
  putJson(SEATS, entry.userId, seat)
  return cjson.encode({ result = 'seated', replacedSocketId = replaced })
end

if admission == 'manual' and not isHost then
  return cjson.encode({ result = 'queued', position = enqueue(entry) })
end
-- A seat that just freed belongs to the lobby, which drainQueue fills in order. A
-- newcomer arriving in that gap goes to the back of the line, not into the seat.
if not isHost and othersQueued(entry.userId) then
  return cjson.encode({ result = 'queued', position = enqueue(entry) })
end
-- The host's seat is always reserved, so everyone else shares max - 1.
if not isHost and nonHostSeats() >= max - 1 then
  -- A translator convo is a 2-seat link, not a lobby.
  if mode == 'translator' then return cjson.encode({ result = 'full' }) end
  return cjson.encode({ result = 'queued', position = enqueue(entry) })
end
redis.call('HDEL', QUEUE, entry.userId)
putJson(SEATS, entry.userId, newSeat(entry, isHost))
return cjson.encode({ result = 'seated', replacedSocketId = '' })`,

  // ARGV: userId. Still waiting and a seat free: seated and out of the lobby at once.
  zyloRoomAdmit: `
local entry = getJson(QUEUE, ARGV[1])
if not entry or redis.call('EXISTS', META) == 0 then return cjson.encode({ result = 'gone' }) end
-- Removed while queued (host:kick reads the seat and the entry in two calls): no seat.
if redis.call('SISMEMBER', REMOVED, ARGV[1]) == 1 then return cjson.encode({ result = 'gone' }) end
local max = tonumber(redis.call('HGET', META, 'maxParticipants'))
if nonHostSeats() >= max - 1 then return cjson.encode({ result = 'full' }) end
redis.call('HDEL', QUEUE, ARGV[1])
putJson(SEATS, ARGV[1], newSeat(entry, false))
return cjson.encode({ result = 'admitted', entry = entry })`,

  // Seats the lobby in order until the room is full. Serves both "a seat freed" and
  // "the host switched manual to auto": they are the same operation. In manual mode
  // it seats nobody, whatever the caller read a moment ago: the host admits one by one.
  zyloRoomDrain: `
if redis.call('EXISTS', META) == 0 then return '[]' end
if redis.call('HGET', META, 'admission') == 'manual' then return '[]' end
local max = tonumber(redis.call('HGET', META, 'maxParticipants'))
local taken = nonHostSeats()
local admitted = {}
for _, e in ipairs(sortedQueue()) do
  if taken >= max - 1 then break end
  -- A removed user stays queued but unseated: the kick still finds the entry and tells them.
  if redis.call('SISMEMBER', REMOVED, e.userId) == 0 then
    redis.call('HDEL', QUEUE, e.userId)
    putJson(SEATS, e.userId, newSeat(e, false))
    taken = taken + 1
    admitted[#admitted + 1] = e
  end
end
if #admitted == 0 then return '[]' end
return cjson.encode(admitted)`,

  // ARGV: userId, socketId ('' = whoever holds it).
  zyloRoomRelease: `
local seat = getJson(SEATS, ARGV[1])
if not seat or (ARGV[2] ~= '' and seat.socketId ~= ARGV[2]) then return 0 end
redis.call('HDEL', SEATS, ARGV[1])
dropScreenIfHeldBy(ARGV[1])
return 1`,

  // ARGV: userId, socketId, graceMs. Stamps the deadline once; a second stamp (the
  // sweeper) never extends it.
  zyloRoomMarkGrace: `
local seat = getJson(SEATS, ARGV[1])
if not seat or seat.socketId ~= ARGV[2] then return 0 end
if not seat.graceUntil then
  seat.graceUntil = nowMs() + tonumber(ARGV[3])
  putJson(SEATS, ARGV[1], seat)
end
return 1`,

  // ARGV: userId, socketId. The socket is still here after all: clear the stamp.
  zyloRoomKeepSeat: `
local seat = getJson(SEATS, ARGV[1])
if not seat or seat.socketId ~= ARGV[2] then return 0 end
seat.graceUntil = nil
putJson(SEATS, ARGV[1], seat)
return 1`,

  // ARGV: userId, socketId. Releases only a seat still held by that socket and past
  // its deadline, so a reconnect on any server always wins.
  zyloRoomReleaseIfStale: `
local seat = getJson(SEATS, ARGV[1])
if not seat or seat.socketId ~= ARGV[2] or not seat.graceUntil then return 0 end
if nowMs() < seat.graceUntil then return 0 end
redis.call('HDEL', SEATS, ARGV[1])
dropScreenIfHeldBy(ARGV[1])
return 1`,

  // ARGV: userId, socketId ('' = whoever holds it).
  zyloRoomDequeue: `
local entry = getJson(QUEUE, ARGV[1])
if not entry or (ARGV[2] ~= '' and entry.socketId ~= ARGV[2]) then return 0 end
redis.call('HDEL', QUEUE, ARGV[1])
return 1`,

  // ARGV: userId, socketId, lang.
  zyloRoomSetLang: `
local seat = getJson(SEATS, ARGV[1])
if not seat or seat.socketId ~= ARGV[2] then return 0 end
seat.lang = ARGV[3]
putJson(SEATS, ARGV[1], seat)
return 1`,

  // ARGV: userId, socketId, serverId. The lock belongs to a socket (a share lives in
  // the page that started it); it needs that socket's seat and respects host-only.
  zyloRoomTakeScreen: `
local seat = getJson(SEATS, ARGV[1])
if not seat or seat.socketId ~= ARGV[2] then return cjson.encode({ ok = false, reason = 'noseat' }) end
local meta = redis.call('HMGET', META, 'screenSharePolicy', 'hostId')
if meta[1] == 'host_only' and meta[2] ~= ARGV[1] then return cjson.encode({ ok = false, reason = 'host_only' }) end
local raw = redis.call('GET', SCREEN)
if raw then
  local holder = cjson.decode(raw)
  if holder.socketId ~= ARGV[2] then return cjson.encode({ ok = false, sharerUserId = holder.userId }) end
end
redis.call('SET', SCREEN, cjson.encode({ userId = ARGV[1], socketId = ARGV[2], serverId = ARGV[3] }))
return cjson.encode({ ok = true, sharerUserId = ARGV[1] })`,

  // ARGV: socketId. Only the holder's socket releases; returns what was held, or ''.
  zyloRoomReleaseScreen: `
local raw = redis.call('GET', SCREEN)
if not raw or cjson.decode(raw).socketId ~= ARGV[1] then return '' end
redis.call('DEL', SCREEN)
return raw`,

  // ARGV: ended ('1' leaves the one-hour tombstone). Returns every socket it dropped.
  zyloRoomClear: `
local ids = {}
for _, raw in ipairs(redis.call('HVALS', SEATS)) do ids[#ids + 1] = cjson.decode(raw).socketId end
for _, raw in ipairs(redis.call('HVALS', QUEUE)) do ids[#ids + 1] = cjson.decode(raw).socketId end
redis.call('DEL', META, SEATS, QUEUE, SCREEN, REMOVED, SEQ)
if ARGV[1] == '1' then redis.call('SET', ENDED, '1', 'EX', 3600) end
if #ids == 0 then return '[]' end
return cjson.encode(ids)`,

  // ARGV: idleMs. Clears a room nobody is in or waiting for, once it has gone that long
  // since initMeta last ran on it (so a join between initMeta and its seat is never
  // swept away, even into a room that is already old).
  zyloRoomClearIfIdle: `
if redis.call('EXISTS', META) == 0 then return 0 end
if redis.call('HLEN', SEATS) > 0 or redis.call('HLEN', QUEUE) > 0 then return 0 end
local since = tonumber(redis.call('HGET', META, 'since')) or 0
if nowMs() - since < tonumber(ARGV[1]) then return 0 end
redis.call('DEL', META, SEATS, QUEUE, SCREEN, REMOVED, SEQ)
return 1`,
};

const bySeq = (a, b) => a.seq - b.seq;

function createRoomStore(redis, { serverId }) {
  for (const [name, body] of Object.entries(SCRIPTS)) {
    if (typeof redis[name] !== 'function') redis.defineCommand(name, { numberOfKeys: 7, lua: PRELUDE + body });
  }
  const run = (name, code, ...args) => redis[name](...roomKeys(code), ...args);
  const key = (code, part) => `zylo:room:{${code}}:${part}`;

  async function seatFor(code, userId) {
    const raw = await redis.hget(key(code, 'seats'), userId);
    return raw ? { userId, ...JSON.parse(raw) } : null;
  }

  async function queuedEntries(code) {
    const all = await redis.hgetall(key(code, 'queue'));
    return Object.values(all).map((raw) => JSON.parse(raw)).sort(bySeq);
  }

  return {
    serverId,

    // Settings
    async initMeta(code, { hostId, admission, screenSharePolicy, maxParticipants, mode, aiEnabled = true, aiNudges = false }) {
      const args = [hostId, admission, screenSharePolicy, String(maxParticipants), mode, aiEnabled ? '1' : '0', aiNudges ? '1' : '0'];
      const ok = (await run('zyloRoomInitMeta', code, ...args, String(Date.now()))) === 1;
      if (ok) await redis.sadd(LIVE, code);
      return ok;
    },
    async getMeta(code) {
      const m = await redis.hgetall(key(code, 'meta'));
      if (!m.hostId) return null;
      return {
        hostId: m.hostId,
        admission: m.admission,
        screenSharePolicy: m.screenSharePolicy,
        maxParticipants: Number(m.maxParticipants),
        mode: m.mode,
        // Missing on a room set up by a server from before AI existed: on, like the column default.
        aiEnabled: m.aiEnabled !== '0',
        // Nudges: off when missing, like the column default. Times are ms, 0 when missing.
        aiNudges: m.aiNudges === '1',
        nudgesOnAt: Number(m.nudgesOnAt) || 0,
        lastVoiceAt: Number(m.lastVoiceAt) || 0,
        lastChatAt: Number(m.lastChatAt) || 0,
        quietNudged: m.quietNudged === '1',
      };
    },
    async setMetaField(code, field, value) {
      return (await run('zyloRoomSetMeta', code, field, String(value))) === 1;
    },
    // A nudge signal: field is lastVoiceAt or lastChatAt. False if the room is gone.
    async touch(code, field) {
      return (await run('zyloRoomTouch', code, field, String(Date.now()))) === 1;
    },
    // One server, once per 90 s, may fire a nudge for this meeting. The claim stands
    // even if the AI then stays silent; it shares the room's {code} slot and expires.
    async claimNudge(code) {
      return (await redis.set(key(code, 'nudge'), '1', 'NX', 'PX', NUDGE_CLAIM_MS)) === 'OK';
    },
    async addRemoved(code, userId) {
      await redis.sadd(key(code, 'removed'), userId);
    },

    // Seats
    async join(code, { userId, socketId, name, imageUrl = null, lang = null }, { isHost }) {
      const entry = JSON.stringify({ userId, socketId, serverId, name, imageUrl, lang });
      const out = JSON.parse(await run('zyloRoomJoin', code, entry, isHost ? '1' : '0'));
      return { result: out.result, replacedSocketId: out.replacedSocketId || null, position: out.position ?? null };
    },
    seatFor,
    async hasSeat(code, userId) {
      return (await redis.hexists(key(code, 'seats'), userId)) === 1;
    },
    async seatSocketId(code, userId) {
      return (await seatFor(code, userId))?.socketId ?? null;
    },
    async listSeats(code) {
      const all = await redis.hgetall(key(code, 'seats'));
      return Object.entries(all).map(([userId, raw]) => ({ userId, ...JSON.parse(raw) })).sort(bySeq);
    },
    async setSeatLang(code, userId, socketId, lang) {
      return (await run('zyloRoomSetLang', code, userId, socketId, lang)) === 1;
    },
    async releaseSeat(code, userId, socketId = null) {
      return (await run('zyloRoomRelease', code, userId, socketId ?? '')) === 1;
    },
    async markGrace(code, userId, socketId, graceMs = GRACE_MS) {
      return (await run('zyloRoomMarkGrace', code, userId, socketId, String(graceMs))) === 1;
    },
    async keepSeat(code, userId, socketId) {
      return (await run('zyloRoomKeepSeat', code, userId, socketId)) === 1;
    },
    async releaseIfStale(code, userId, socketId) {
      return (await run('zyloRoomReleaseIfStale', code, userId, socketId)) === 1;
    },

    // Lobby
    queuedEntries,
    async queuePosition(code, userId) {
      const index = (await queuedEntries(code)).findIndex((e) => e.userId === userId);
      return index === -1 ? null : index + 1;
    },
    async queueSocketId(code, userId) {
      const raw = await redis.hget(key(code, 'queue'), userId);
      return raw ? JSON.parse(raw).socketId : null;
    },
    async removeFromQueue(code, userId, socketId = null) {
      return (await run('zyloRoomDequeue', code, userId, socketId ?? '')) === 1;
    },
    async admitFromQueue(code, userId) {
      const out = JSON.parse(await run('zyloRoomAdmit', code, userId));
      return { result: out.result, entry: out.entry ?? null };
    },
    async drainQueue(code) {
      return JSON.parse(await run('zyloRoomDrain', code));
    },

    // Screen-share lock
    async takeScreenLock(code, { userId, socketId }) {
      return JSON.parse(await run('zyloRoomTakeScreen', code, userId, socketId, serverId));
    },
    async screenSharer(code) {
      const raw = await redis.get(key(code, 'screen'));
      return raw ? JSON.parse(raw) : null;
    },
    async releaseScreenLock(code, socketId) {
      const raw = await run('zyloRoomReleaseScreen', code, socketId);
      if (!raw) return null;
      const held = JSON.parse(raw);
      return { userId: held.userId, socketId: held.socketId };
    },

    // Whole room
    async clearMeeting(code, { ended = false } = {}) {
      const ids = JSON.parse(await run('zyloRoomClear', code, ended ? '1' : '0'));
      await redis.srem(LIVE, code);
      return ids;
    },
    async clearIfIdle(code, idleMs) {
      const cleared = (await run('zyloRoomClearIfIdle', code, String(idleMs))) === 1;
      if (cleared) await redis.srem(LIVE, code);
      return cleared;
    },
    liveMeetings: () => redis.smembers(LIVE),
    forgetLive: (code) => redis.srem(LIVE, code),
    markLive: (code) => redis.sadd(LIVE, code),

    // Servers
    beat: () => redis.set(`zylo:server:${serverId}`, String(Date.now()), 'PX', HEARTBEAT_TTL_MS),
    async isServerAlive(id) {
      return (await redis.exists(`zylo:server:${id}`)) === 1;
    },
  };
}

module.exports = { createRoomStore, roomKeys, GRACE_MS, HEARTBEAT_TTL_MS };
