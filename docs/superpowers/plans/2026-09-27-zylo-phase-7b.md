# Zylo Phase 7b: Rooms on Redis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move live room state (seats, lobby, screen-share lock, live meeting settings, removals) from one process's memory into Redis, and add the Socket.IO Redis adapter, so several API servers can serve the same meetings.

**Architecture:** A new `roomStore.js` holds each meeting's state in Redis hashes; every check-and-change is one Lua script, so the last-seat and screen-lock races stay safe across servers. `room.js` calls the store (now `async`), reaches sockets on other servers through `io.to(id)` / `io.in(id)`, and checks socket ownership in every handler. A heartbeat per server plus a sweeper frees seats of crashed servers and ends abandoned meetings. When Redis is down, rooms fail closed.

**Tech Stack:** Node 22, Socket.IO 4.8 + `@socket.io/redis-adapter`, ioredis 5, Redis 7 Lua (with `cjson`), Postgres 16, node:test.

**Spec:** `docs/superpowers/specs/2026-09-27-zylo-phase-7-redis-design.md` (sections 5 and 6)

## Global Constraints

- Starts after Phase 7a (`docs/superpowers/plans/2026-09-27-zylo-phase-7a.md`) is done, on the same `phase-7-redis` branch.
- Execution model: Sonnet subagents write the code; the orchestrating session reviews each task.
- Room keys are exactly `zylo:room:{<code>}:meta|seats|queue|screen|removed|seq|ended` (braces included), plus `zylo:rooms:live` and `zylo:server:<serverId>`. No script touches `zylo:rooms:live`.
- Room keys never get a TTL, except the `ended` tombstone (1 hour).
- Every Lua script receives the same 7 keys in the same order (`roomKeys(code)`), returns a JSON string, an integer or a plain string, and reads the clock only through `redis.call('TIME')`.
- Rooms fail **closed**: a store error during a join is `meeting:denied { reason: 'unavailable' }`; any other handler's error is logged and the event dropped. Never admit, relay or authorize anything when the store can't be read.
- `socket.data.meetingId` is only a hint: every handler that acts checks in the store that this socket owns the seat (or lobby entry) it acts through.
- The existing socket suites are the regression net: their assertions about behaviour don't change; only store reads become `await store.x(...)` and set-up/tear-down moves to the new helpers.
- Never `git add -A`; stage the files each task names. Don't push unless the user asks. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the attribution line the session gives you).
- Tests need `npm run db:up` (Postgres and Redis). Server tests: `cd server && npm test`.

## File map

| File | Responsibility |
|---|---|
| `server/lib/roomStore.js` (new) | Room state in Redis: Lua scripts and their JS wrappers, heartbeat |
| `server/lib/seats.js` (deleted in Task 9) | The in-memory store it replaces |
| `server/lib/room.js` | Socket handlers on the async store; cross-server socket calls; grace timers; heartbeat and sweeper |
| `server/lib/meetings.js`, `server/lib/webhook.js` | Seat checks through the store |
| `server/app.js`, `server/server.js` | Store and adapter wiring; boot clean-up replaced by the sweeper |
| `server/test/helpers.js` | Test Redis without auto-close, room harness on the store, two-server harness |
| `server/test/roomStore.test.js` (new, replaces `seats.test.js`) | Store behaviour and races |
| `server/test/multiServer.test.js` (new) | Two real servers sharing Redis |
| `web/lib/use-meeting.ts`, `web/components/meeting-room-flow.tsx` | The `unavailable` denial |

---

### Task 8: The room store in Redis

**Files:**
- Create: `server/lib/roomStore.js`
- Create: `server/test/roomStore.test.js`

**Interfaces:**
- Consumes: `setupTestRedis`, `settle` (test helpers).
- Produces (methods are `async` unless marked):
  - `createRoomStore(redis, { serverId }) → store`; module also exports `GRACE_MS = 30000`, `HEARTBEAT_TTL_MS = 30000`, `roomKeys(code) → string[7]`.
  - `store.serverId` (plain property).
  - Settings: `initMeta(code, { hostId, admission, screenSharePolicy, maxParticipants, mode }) → boolean` (false while the ended tombstone exists); `getMeta(code) → { hostId, admission, screenSharePolicy, maxParticipants: number, mode } | null`; `setMetaField(code, field, value) → boolean` (false when the room is gone); `addRemoved(code, userId)`.
  - Seats: `join(code, { userId, socketId, name, imageUrl, lang }, { isHost }) → { result: 'seated'|'queued'|'full'|'removed'|'ended', replacedSocketId: string|null, position: number|null }`; `seatFor(code, userId) → { userId, socketId, serverId, name, imageUrl, isHost, lang, seq, graceUntil? } | null`; `hasSeat`; `seatSocketId`; `listSeats(code)` (join order); `setSeatLang(code, userId, socketId, lang) → boolean`; `releaseSeat(code, userId, socketId = null) → boolean`; `markGrace(code, userId, socketId, graceMs) → boolean`; `keepSeat(code, userId, socketId) → boolean`; `releaseIfStale(code, userId, socketId) → boolean`.
  - Lobby: `queuedEntries(code)` (FIFO); `queuePosition(code, userId) → number|null`; `queueSocketId(code, userId) → string|null`; `removeFromQueue(code, userId, socketId = null) → boolean`; `admitFromQueue(code, userId) → { result: 'admitted'|'full'|'gone', entry: object|null }`; `drainQueue(code) → entry[]`.
  - Screen: `takeScreenLock(code, { userId, socketId }) → { ok: true, sharerUserId } | { ok: false, sharerUserId } | { ok: false, reason: 'noseat'|'host_only' }`; `screenSharer(code) → { userId, socketId, serverId } | null`; `releaseScreenLock(code, socketId) → { userId, socketId } | null`.
  - Room: `clearMeeting(code, { ended = false } = {}) → socketId[]`; `clearIfIdle(code, idleMs) → boolean`; `liveMeetings() → string[]`; `forgetLive(code)`.
  - Servers: `beat()`; `isServerAlive(serverId) → boolean`.

- [ ] **Step 1: Write the failing tests**

Create `server/test/roomStore.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoomStore } = require('../lib/roomStore');
const { setupTestRedis, settle } = require('./helpers');

const CODE = 'abc-defg-hij';
// u9 is the host; max 3 means the host plus 2 others.
const META = { hostId: 'u9', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 3, mode: 'standard' };
const person = (n, socketId = `s${n}`) => ({ userId: `u${n}`, socketId, name: `User ${n}`, imageUrl: null });

async function room(t, meta = {}) {
  const store = createRoomStore(await setupTestRedis(t), { serverId: 'server-a' });
  await store.initMeta(CODE, { ...META, ...meta });
  return store;
}
const seat = (store, n, isHost = false) => store.join(CODE, person(n), { isHost });

test('the host seat is reserved on top of the max - 1 participant seats', async (t) => {
  const store = await room(t);
  assert.equal((await seat(store, 1)).result, 'seated');
  assert.equal((await seat(store, 2)).result, 'seated');
  assert.deepEqual(await seat(store, 3), { result: 'queued', replacedSocketId: null, position: 1 });
  assert.equal((await seat(store, 9, true)).result, 'seated');
  assert.equal((await store.listSeats(CODE)).length, 3);
});

test('50 joins at the same moment from two servers: exactly one gets the last seat', async (t) => {
  const a = createRoomStore(await setupTestRedis(t), { serverId: 'server-a' });
  const b = createRoomStore(await setupTestRedis(t), { serverId: 'server-b' });
  await a.initMeta(CODE, META);
  await seat(a, 9, true);
  await seat(a, 1);
  const outcomes = await Promise.all(
    Array.from({ length: 50 }, (_, i) => (i % 2 ? b : a).join(CODE, person(100 + i), { isHost: false })),
  );
  assert.equal(outcomes.filter((o) => o.result === 'seated').length, 1);
  const positions = outcomes.filter((o) => o.result === 'queued').map((o) => o.position).sort((x, y) => x - y);
  assert.deepEqual(positions, Array.from({ length: 49 }, (_, i) => i + 1));
});

test('the lobby is FIFO, a retry keeps its place, and a freed seat admits the first in line', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  assert.equal((await seat(store, 3)).position, 1);
  assert.equal((await seat(store, 4)).position, 2);
  assert.equal((await seat(store, 5)).position, 3);
  const retry = await store.join(CODE, person(4, 's4b'), { isHost: false });
  assert.equal(retry.position, 2);
  assert.equal(await store.queueSocketId(CODE, 'u4'), 's4b');

  assert.deepEqual(await store.drainQueue(CODE), []); // still full
  assert.equal(await store.releaseSeat(CODE, 'u2'), true);
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u3']);
  assert.equal(await store.queuePosition(CODE, 'u4'), 1);
  assert.equal(await store.queuePosition(CODE, 'u5'), 2);
  assert.equal(await store.queuePosition(CODE, 'u3'), null);
});

test('manual admission: everyone but the host waits; switching to auto drains in order until full', async (t) => {
  const store = await room(t, { admission: 'manual', maxParticipants: 3 });
  assert.equal((await seat(store, 9, true)).result, 'seated');
  for (const n of [2, 3, 4]) assert.equal((await seat(store, n)).result, 'queued');
  assert.equal(await store.setMetaField(CODE, 'admission', 'auto'), true);
  assert.deepEqual((await store.drainQueue(CODE)).map((e) => e.userId), ['u2', 'u3']);
  assert.deepEqual((await store.queuedEntries(CODE)).map((e) => e.userId), ['u4']);
  assert.equal(await store.queuePosition(CODE, 'u4'), 1);
});

test('admitFromQueue: gone, full, or seated and out of the lobby in one step', async (t) => {
  const store = await room(t, { admission: 'manual', maxParticipants: 2 });
  await seat(store, 9, true);
  await seat(store, 1);
  await seat(store, 2);
  assert.deepEqual(await store.admitFromQueue(CODE, 'u7'), { result: 'gone', entry: null });
  assert.equal((await store.admitFromQueue(CODE, 'u1')).result, 'admitted');
  assert.equal((await store.admitFromQueue(CODE, 'u2')).result, 'full');
  assert.equal(await store.queuePosition(CODE, 'u2'), 1, 'a full room keeps them in line');
  assert.equal(await store.hasSeat(CODE, 'u1'), true);
  assert.equal(await store.queueSocketId(CODE, 'u1'), null);
});

test('removed, ended and a full translator convo are refused, not queued', async (t) => {
  const store = await room(t);
  await store.addRemoved(CODE, 'u1');
  assert.equal((await seat(store, 1)).result, 'removed');
  assert.equal((await store.join('zzz-zzzz-zzz', person(1), { isHost: false })).result, 'ended'); // never initialised

  const convoCode = 'cnv-cnvo-cnv';
  await store.initMeta(convoCode, { ...META, mode: 'translator', maxParticipants: 2 });
  await store.join(convoCode, person(9), { isHost: true });
  await store.join(convoCode, person(2), { isHost: false });
  assert.equal((await store.join(convoCode, person(3), { isHost: false })).result, 'full');
});

test('an ended meeting cannot be brought back for an hour; a cleared, never-started one can', async (t) => {
  const store = await room(t);
  await store.clearMeeting(CODE, { ended: true });
  assert.equal(await store.initMeta(CODE, META), false);
  assert.equal((await seat(store, 1)).result, 'ended');

  const other = 'xyz-wxyz-xyz';
  await store.initMeta(other, META);
  await store.clearMeeting(other, { ended: false });
  assert.equal(await store.initMeta(other, META), true);
});

test('a second tab takes the seat over, reports the old socket, and keeps its place in the roster', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  const second = await store.join(CODE, person(1, 's1b'), { isHost: false });
  assert.deepEqual(second, { result: 'seated', replacedSocketId: 's1', position: null });
  assert.deepEqual((await store.listSeats(CODE)).map((s) => s.userId), ['u1', 'u2']);
  assert.equal(await store.seatSocketId(CODE, 'u1'), 's1b');
});

test('seatFor returns the seat record, or null for a stranger or an unknown meeting', async (t) => {
  const store = await room(t);
  await seat(store, 9, true);
  const s = await store.seatFor(CODE, 'u9');
  assert.equal(s.userId, 'u9');
  assert.equal(s.socketId, 's9');
  assert.equal(s.serverId, 'server-a');
  assert.equal(s.name, 'User 9');
  assert.equal(s.imageUrl, null);
  assert.equal(s.isHost, true);
  assert.equal(s.lang, null);
  assert.equal(await store.seatFor(CODE, 'u2'), null);
  assert.equal(await store.seatFor('zzz-zzzz-zzz', 'u9'), null);
});

test('grace: the seat is held until the deadline, then released once', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  assert.equal(await store.markGrace(CODE, 'u1', 's1', 50), true);
  assert.equal(await store.hasSeat(CODE, 'u1'), true);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), false, 'not yet');
  await settle(80);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), true);
  assert.equal(await store.hasSeat(CODE, 'u1'), false);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), false, 'only once');
});

test('grace: coming back on any server ends it, and keepSeat clears a stamp', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await store.markGrace(CODE, 'u1', 's1', 50);
  await store.join(CODE, person(1, 's1b'), { isHost: false });
  await settle(80);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1'), false);
  assert.equal((await store.seatFor(CODE, 'u1')).graceUntil, undefined);

  await store.markGrace(CODE, 'u1', 's1b', 50);
  assert.equal(await store.keepSeat(CODE, 'u1', 's1b'), true);
  await settle(80);
  assert.equal(await store.releaseIfStale(CODE, 'u1', 's1b'), false);
});

test('only the socket that holds a seat or lobby entry can give it up, unless no socket is named', async (t) => {
  const store = await room(t, { maxParticipants: 2 });
  await seat(store, 1);
  await seat(store, 2); // queued
  assert.equal(await store.releaseSeat(CODE, 'u1', 'someone-else'), false);
  assert.equal(await store.removeFromQueue(CODE, 'u2', 'someone-else'), false);
  assert.equal(await store.markGrace(CODE, 'u1', 'someone-else', 50), false);
  assert.equal(await store.setSeatLang(CODE, 'u1', 'someone-else', 'hi'), false);
  assert.equal(await store.releaseSeat(CODE, 'u1', 's1'), true);
  assert.equal(await store.removeFromQueue(CODE, 'u2'), true); // the host acting: any socket
});

test('screen lock: one sharer, owned by a socket, and only for someone seated', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  const [a, b] = await Promise.all([
    store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' }),
    store.takeScreenLock(CODE, { userId: 'u2', socketId: 's2' }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  const winner = a.ok ? 'u1' : 'u2';
  assert.equal((a.ok ? b : a).sharerUserId, winner);
  assert.deepEqual(await store.takeScreenLock(CODE, { userId: 'u7', socketId: 's7' }), { ok: false, reason: 'noseat' });

  await store.releaseScreenLock(CODE, winner === 'u1' ? 's1' : 's2');
  assert.equal((await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' })).ok, true);
  assert.equal((await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' })).ok, true, 'the same page may ask again');
  assert.equal(await store.releaseScreenLock(CODE, 's2'), null, 'only the holder releases');
  assert.deepEqual(await store.releaseScreenLock(CODE, 's1'), { userId: 'u1', socketId: 's1' });
  assert.equal(await store.screenSharer(CODE), null);
});

test('screen lock: host-only is enforced inside the script', async (t) => {
  const store = await room(t, { screenSharePolicy: 'host_only' });
  await seat(store, 9, true);
  await seat(store, 1);
  assert.deepEqual(await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' }), { ok: false, reason: 'host_only' });
  assert.equal((await store.takeScreenLock(CODE, { userId: 'u9', socketId: 's9' })).ok, true);
});

test('the sharer losing their seat loses the lock, by leaving or by grace running out', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  await seat(store, 2);
  await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' });
  await store.releaseSeat(CODE, 'u2'); // someone else leaving changes nothing
  assert.equal((await store.screenSharer(CODE)).userId, 'u1');
  await store.releaseSeat(CODE, 'u1');
  assert.equal(await store.screenSharer(CODE), null);

  await store.join(CODE, person(1), { isHost: false });
  await store.takeScreenLock(CODE, { userId: 'u1', socketId: 's1' });
  await store.markGrace(CODE, 'u1', 's1', 20);
  await settle(50);
  await store.releaseIfStale(CODE, 'u1', 's1');
  assert.equal(await store.screenSharer(CODE), null);
});

test('clearMeeting returns every socket it dropped and leaves nothing behind', async (t) => {
  const store = await room(t, { maxParticipants: 2 });
  await seat(store, 9, true);
  await seat(store, 1);
  await seat(store, 2); // queued
  const ids = await store.clearMeeting(CODE);
  assert.deepEqual(ids.sort(), ['s1', 's2', 's9']);
  assert.equal(await store.getMeta(CODE), null);
  assert.deepEqual(await store.listSeats(CODE), []);
  assert.deepEqual(await store.queuedEntries(CODE), []);
  assert.deepEqual(await store.liveMeetings(), []);
});

test('clearIfIdle: only an empty room that has existed long enough', async (t) => {
  const store = await room(t);
  assert.equal(await store.clearIfIdle(CODE, 60_000), false, 'too new');
  await seat(store, 1);
  assert.equal(await store.clearIfIdle(CODE, 0), false, 'someone is seated');
  await store.releaseSeat(CODE, 'u1');
  assert.equal(await store.clearIfIdle(CODE, 0), true);
  assert.equal(await store.getMeta(CODE), null);
});

test('setSeatLang and setMetaField change only what exists', async (t) => {
  const store = await room(t);
  await seat(store, 1);
  assert.equal(await store.setSeatLang(CODE, 'u1', 's1', 'hi'), true);
  assert.equal((await store.seatFor(CODE, 'u1')).lang, 'hi');
  await store.clearMeeting(CODE);
  assert.equal(await store.setMetaField(CODE, 'admission', 'manual'), false, 'no room to change');
  assert.equal(await store.getMeta(CODE), null);
});

test('heartbeats: a server is alive while it beats', async (t) => {
  const redis = await setupTestRedis(t);
  const store = createRoomStore(redis, { serverId: 'server-a' });
  assert.equal(await store.isServerAlive('server-a'), false);
  await store.beat();
  assert.equal(await store.isServerAlive('server-a'), true);
  assert.ok((await redis.pttl('zylo:server:server-a')) <= 30_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && node --test test/roomStore.test.js`
Expected: FAIL with `Cannot find module '../lib/roomStore'`.

- [ ] **Step 3: Write `server/lib/roomStore.js`**

```js
// Live room state in Redis, so every API server sees the same rooms: seats, the
// lobby, the screen-share lock, the live meeting settings and who was removed.
// Each check-and-change is one Lua script. Redis runs a script without letting any
// other command in, which is what keeps the last seat, the lobby order and the
// screen-share lock race-safe across servers (the job "no await between the check
// and the write" did when this lived in one process's memory).
//
// Keys per meeting. The {code} braces are a Redis Cluster hash tag: all of one
// meeting's keys land together, so one script may touch them all.
//   zylo:room:{code}:meta     hash   hostId, admission, screenSharePolicy, maxParticipants, mode, since
//   zylo:room:{code}:seats    hash   userId -> { socketId, serverId, name, imageUrl, isHost, lang, seq, graceUntil? }
//   zylo:room:{code}:queue    hash   userId -> { userId, socketId, serverId, name, imageUrl, lang, seq }
//   zylo:room:{code}:screen   string { userId, socketId, serverId }
//   zylo:room:{code}:removed  set    user ids the host removed
//   zylo:room:{code}:seq      counter that orders seats and lobby entries
//   zylo:room:{code}:ended    tombstone for an hour after the meeting ended
// No TTLs: a room's keys go when it ends, and room.js's sweeper catches leftovers.
// Outside any script: zylo:rooms:live (codes the sweeper walks), zylo:server:<id>.

const GRACE_MS = 30_000;
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
  // ARGV: hostId, admission, screenSharePolicy, maxParticipants, mode. 0 while the
  // ended tombstone exists: a join that read the meeting row just before "End for
  // all" committed must not bring the room back.
  zyloRoomInitMeta: `
if redis.call('EXISTS', ENDED) == 1 then return 0 end
if redis.call('EXISTS', META) == 0 then
  redis.call('HSET', META, 'hostId', ARGV[1], 'admission', ARGV[2], 'screenSharePolicy', ARGV[3],
    'maxParticipants', ARGV[4], 'mode', ARGV[5], 'since', tostring(nowMs()))
end
return 1`,

  // ARGV: field, value. Never recreates a room that already ended.
  zyloRoomSetMeta: `
if redis.call('EXISTS', META) == 0 then return 0 end
redis.call('HSET', META, ARGV[1], ARGV[2])
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
local max = tonumber(redis.call('HGET', META, 'maxParticipants'))
if nonHostSeats() >= max - 1 then return cjson.encode({ result = 'full' }) end
redis.call('HDEL', QUEUE, ARGV[1])
putJson(SEATS, ARGV[1], newSeat(entry, false))
return cjson.encode({ result = 'admitted', entry = entry })`,

  // Seats the lobby in order until the room is full. Serves both "a seat freed" and
  // "the host switched manual to auto": they are the same operation.
  zyloRoomDrain: `
if redis.call('EXISTS', META) == 0 then return '[]' end
local max = tonumber(redis.call('HGET', META, 'maxParticipants'))
local taken = nonHostSeats()
local admitted = {}
for _, e in ipairs(sortedQueue()) do
  if taken >= max - 1 then break end
  redis.call('HDEL', QUEUE, e.userId)
  putJson(SEATS, e.userId, newSeat(e, false))
  taken = taken + 1
  admitted[#admitted + 1] = e
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

  // ARGV: idleMs. Clears a room nobody is in or waiting for, once it has existed that
  // long (so a join between initMeta and its seat is never swept away).
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
    async initMeta(code, { hostId, admission, screenSharePolicy, maxParticipants, mode }) {
      const ok = (await run('zyloRoomInitMeta', code, hostId, admission, screenSharePolicy, String(maxParticipants), mode)) === 1;
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
      };
    },
    async setMetaField(code, field, value) {
      return (await run('zyloRoomSetMeta', code, field, String(value))) === 1;
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

    // Servers
    beat: () => redis.set(`zylo:server:${serverId}`, String(Date.now()), 'PX', HEARTBEAT_TTL_MS),
    async isServerAlive(id) {
      return (await redis.exists(`zylo:server:${id}`)) === 1;
    },
  };
}

module.exports = { createRoomStore, roomKeys, GRACE_MS, HEARTBEAT_TTL_MS };
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test test/roomStore.test.js`
Expected: all pass.

Run: `cd server && npm test`
Expected: all pass (`room.js` still uses `seats.js`; nothing else changed).

- [ ] **Step 5: Mutation checks**

Make each change, run `node --test test/roomStore.test.js`, see a failure, undo:
1. In `zyloRoomJoin`, change `nonHostSeats() >= max - 1` to `nonHostSeats() > max - 1` (the host-seat and 50-way race tests fail).
2. In `zyloRoomRelease`, drop the `ARGV[2] ~= '' and` socket check (the "only the socket that holds a seat" test fails).
3. In `zyloRoomTakeScreen`, delete the host-only line (the host-only test fails).
4. In `zyloRoomJoin`'s takeover branch, delete `seat.graceUntil = nil` (the "coming back on any server" test fails).
5. In `zyloRoomClear`, never set the tombstone (the "ended meeting cannot be brought back" test fails).

- [ ] **Step 6: Commit**

```bash
git add server/lib/roomStore.js server/test/roomStore.test.js
git commit -m "feat(server): room store in Redis, one Lua script per check-and-change"
```

### Task 9: `room.js` on the store (one server, same behaviour)

This task switches every handler to the async store and to socket calls that work across servers, then deletes `seats.js`. It still runs as one server; Task 10 adds the adapter and the sweeper. The whole existing socket suite is the gate.

**Files:**
- Modify: `server/lib/room.js` (rewritten; full file below)
- Modify: `server/lib/meetings.js`, `server/lib/webhook.js` (seat checks via the store)
- Modify: `server/app.js`, `server/server.js` (create and pass the store)
- Modify: `server/test/helpers.js` (store-backed `startRoom`/`roomHarness`, new helpers)
- Modify: `server/test/room.test.js`, `host.test.js`, `screen.test.js`, `captions.test.js`, `translator.test.js`, `livekit.test.js`, `webhook.test.js` (store reads awaited; set-up via helpers)
- Create: `server/test/ownership.test.js`
- Delete: `server/lib/seats.js`, `server/test/seats.test.js`

**Interfaces:**
- Consumes: `createRoomStore`, `GRACE_MS` (Task 8); `allowEvent`/`SOCKET_POLICIES` (7a Task 5); `createRedis`, `whenReady` (7a Task 1).
- Produces:
  - `registerRoomHandlers(io, { db, store, livekit = null, graceMs = GRACE_MS }) → { stop() }` (`stop` cancels grace timers and refuses to start new ones).
  - `closeStaleMeetings(db, store)` (boot clean-up for one server; Task 10 removes it).
  - `createApp({ ..., store = null })`; `meetingsRouter(db, livekit, limiter, store)`; `livekitWebhook(livekit, store)`.
  - Test helpers: `connectTestRedis()`; `startRoom(db, { redis?, serverId = 'server-a', graceMs = 60, livekit = null, meetingId, admission, screenSharePolicy, maxParticipants, mode })` → `{ meetingId, server: { url, close }, store, handlers }` (creates and closes its own Redis unless given one); `roomHarness(t, options)` → adds `store`; `takeOverSeat(store, meetingId, userId, socketId)`; `seatInStore(store, meetingId, { userId, socketId?, name?, isHost? })`.

- [ ] **Step 1: Write the new ownership tests**

These pass on today's one-server code (which nulls a replaced tab's `meetingId` by hand); after the rewrite they are what proves the store-side ownership checks work, since the rewrite no longer touches the old tab's data.

Create `server/test/ownership.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roomHarness, waitForEvent, collect, settle } = require('./helpers');

// A new tab takes the seat over. The old tab is told it was replaced, but its socket
// may stay open (and on another server its hint of a meeting is never cleared), so
// what it sends next must not act through a seat it no longer holds.
async function secondTab(connect, meetingId, userId) {
  const tab = connect(userId);
  const admitted = waitForEvent(tab, 'meeting:admitted');
  tab.emit('meeting:join-request', { meetingId });
  await admitted;
  return tab;
}

test("a replaced tab's leave does not free the new tab's seat", async (t) => {
  const { connect, join, store, meetingId } = await roomHarness(t);
  await join('host');
  const tabA = await join('p1');
  const tabB = await secondTab(connect, meetingId, 'p1');
  tabA.emit('meeting:leave');
  await settle(150);
  assert.equal(await store.seatSocketId(meetingId, 'p1'), tabB.id);
});

test('a replaced host tab has no host powers', async (t) => {
  const { connect, join, livekit, meetingId } = await roomHarness(t);
  const tabA = await join('host');
  await join('p1');
  await secondTab(connect, meetingId, 'host');
  const forbidden = collect(tabA, 'error:forbidden');
  tabA.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(forbidden.length, 1);
  assert.equal(livekit.callsTo('muteMic').length, 0);
});

test('an admitted person gets the roster straight after being admitted', async (t) => {
  const { connect, join, meetingId } = await roomHarness(t);
  await join('host');
  const client = connect('p1');
  const events = [];
  client.on('meeting:admitted', () => events.push('admitted'));
  client.on('room:presence', ({ people }) => events.push(`presence:${people.length}`));
  client.emit('meeting:join-request', { meetingId });
  await settle(200);
  assert.equal(events[0], 'admitted');
  assert.equal(events[1], 'presence:2');
});
```

- [ ] **Step 2: Rewrite `server/lib/room.js`**

Replace the whole file with:

```js
const { validateChatText } = require('./chatRules');
const { isConvoLang, validateCaption } = require('./captionRules');
const { SOCKET_POLICIES, takeToken } = require('./rateLimit');
const { GRACE_MS } = require('./roomStore');

const roomChannel = (meetingId) => `meeting:${meetingId}`;

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
function registerRoomHandlers(io, { db, store, livekit = null, graceMs = GRACE_MS }) {
  const graceTimers = new Set();
  let stopped = false;

  async function loadMeetingMeta(meetingId) {
    const live = await store.getMeta(meetingId);
    if (live) return live;
    const { rows } = await db.query(
      `SELECT host_id, admission, screen_share_policy, max_participants, mode, ended_at
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
  // before anyone was admitted never gets a bogus ended_at.
  const markEnded = (meetingId) =>
    db.query(
      'UPDATE meetings SET ended_at = now() WHERE id = $1 AND started_at IS NOT NULL AND ended_at IS NULL',
      [meetingId],
    );

  const upsertParticipant = (meetingId, userId, isHostUser) =>
    db.query(
      `INSERT INTO meeting_participants (meeting_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (meeting_id, user_id) DO NOTHING`,
      [meetingId, userId, isHostUser ? 'host' : 'participant'],
    );

  const isConnected = async (socketId) => (await io.in(socketId).fetchSockets()).length > 0;

  // Every seat release goes through here, so none can forget LiveKit: the seat is
  // the only thing that authorizes media. socketId: release only if that socket
  // still holds the seat; null for the host acting on someone.
  async function freeSeat(meetingId, userId, socketId = null) {
    const released = await store.releaseSeat(meetingId, userId, socketId);
    if (released) livekit?.evict(meetingId, userId); // never rejects
    return released;
  }

  async function broadcastPresence(meetingId, to = roomChannel(meetingId)) {
    const people = (await store.listSeats(meetingId)).map(({ userId, name, imageUrl, isHost, lang }) => ({
      userId,
      name,
      imageUrl,
      isHost,
      lang: lang ?? null,
    }));
    io.to(to).emit('room:presence', { people });
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
    io.to(socketId).emit('meeting:admitted');
    // Straight to this socket: on another server the room join above can land after
    // the caller's room-wide broadcast. A second copy of the roster is harmless.
    await broadcastPresence(meetingId, socketId);
    const sharer = await store.screenSharer(meetingId);
    io.to(socketId).emit('screen:state', { sharerUserId: sharer?.userId ?? null });
  }

  // drainQueue already took the seat; a tab that closed meanwhile hands it straight back.
  async function admitDrained(entry, meetingId) {
    if (!(await isConnected(entry.socketId))) {
      await freeSeat(meetingId, entry.userId, entry.socketId);
      return;
    }
    await admit(entry.socketId, meetingId, entry.userId, false, null);
  }

  async function onSeatFreed(meetingId) {
    const meta = await store.getMeta(meetingId);
    if (!meta) return;
    if (meta.admission === 'auto') {
      for (const entry of await store.drainQueue(meetingId)) await admitDrained(entry, meetingId);
    }
    await broadcastPresence(meetingId);
    await broadcastScreen(meetingId); // a released seat drops the lock with it
    await broadcastLobby(meetingId);
    if ((await store.listSeats(meetingId)).length > 0) return;
    await endEmptyRoom(meetingId);
  }

  // Nobody is seated any more, so the meeting is over. Anyone still in the lobby is
  // told rather than left spinning.
  async function endEmptyRoom(meetingId) {
    for (const entry of await store.queuedEntries(meetingId)) {
      io.to(entry.socketId).emit('meeting:denied', { reason: 'ended' });
    }
    const { rowCount } = await markEnded(meetingId);
    await store.clearMeeting(meetingId, { ended: rowCount > 0 });
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
      expireGrace(meetingId, userId, socketId).catch((err) => console.error('seat release failed:', err.message));
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
  // rejection would take the process down. One wrapper covers every handler.
  const on = (socket, event, handler) =>
    socket.on(event, (...args) =>
      Promise.resolve()
        .then(() => handler(...args))
        .catch((err) => console.error(`socket ${event} failed:`, err.message)),
    );

  io.on('connection', (socket) => {
    on(socket, 'meeting:join-request', async ({ meetingId, lang } = {}) => {
      if (!allowEvent(socket, 'meeting:join-request')) return socket.emit('rate-limited', { event: 'meeting:join-request' });
      if (typeof meetingId !== 'string') return socket.emit('meeting:denied', { reason: 'not_found' });
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
      await broadcastPresence(meetingId);
      // A host arriving needs to see whoever is already waiting for them.
      if (isHostUser) await broadcastLobby(meetingId);
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
      const [seat, meta] = await Promise.all([store.seatFor(meetingId, userId), store.getMeta(meetingId)]);
      if (!seat || seat.socketId !== socket.id) return;
      if (!meta || meta.mode !== 'translator') return;
      // Captions are chatty (interim results, client-throttled to ~4/s); extras past
      // the bucket are dropped silently, since the next interim replaces them anyway.
      if (!allowEvent(socket, 'convo:caption')) return;
      const clean = validateCaption(payload);
      if (!clean) return;
      socket.to(roomChannel(meetingId)).emit('convo:caption', { userId, name: seat.name, ...clean, ts: Date.now() });
    });

    on(socket, 'meeting:leave', async () => {
      const { meetingId, userId } = socket.data;
      if (!meetingId) return socket.disconnect(true);
      // Only what this socket owns: a replaced tab's leave must not free the new tab's seat.
      await store.removeFromQueue(meetingId, userId, socket.id);
      await freeSeat(meetingId, userId, socket.id);
      socket.leave(roomChannel(meetingId));
      socket.data.meetingId = null;
      await onSeatFreed(meetingId);
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
      io.to(roomChannel(meetingId)).emit('chat:message', { userId, name: seat.name, text: clean, ts: Date.now() });
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
        console.error('screen share grant failed:', err.message);
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
      if (!(await isConnected(outcome.entry.socketId))) {
        await freeSeat(meetingId, userId, outcome.entry.socketId);
        await broadcastLobby(meetingId);
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
      io.to(roomChannel(meetingId)).emit('meeting:settings', { admission: mode, screenSharePolicy: meta.screenSharePolicy });
      if (mode === 'auto') {
        for (const entry of await store.drainQueue(meetingId)) await admitDrained(entry, meetingId);
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
      io.to(roomChannel(meetingId)).emit('meeting:settings', { admission: meta.admission, screenSharePolicy: policy });
      await db.query('UPDATE meetings SET screen_share_policy = $1 WHERE id = $2', [policy, meetingId]);
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
      await markEnded(meetingId);
      const socketIds = await store.clearMeeting(meetingId, { ended: true });
      for (const id of socketIds) {
        io.in(id).socketsLeave(roomChannel(meetingId));
        io.to(id).emit('meeting:ended');
      }
      livekit?.endRoom(meetingId); // after the sockets, as in host:kick; never rejects
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
    // Cancels pending grace timers and starts no new ones (tests; shutdown later).
    stop() {
      stopped = true;
      for (const timer of graceTimers) clearTimeout(timer);
      graceTimers.clear();
    },
  };
}

// Boot clean-up while there is one API server (Task 10 replaces it with the sweeper):
// rooms left in Redis belong to a process that is gone, and so do meetings marked
// started but never ended.
async function closeStaleMeetings(db, store) {
  for (const code of await store.liveMeetings()) await store.clearMeeting(code);
  await db.query('UPDATE meetings SET ended_at = now() WHERE started_at IS NOT NULL AND ended_at IS NULL');
}

module.exports = { registerRoomHandlers, closeStaleMeetings, roomChannel };
```

- [ ] **Step 3: Seat checks through the store in the HTTP routes**

`server/lib/meetings.js`: delete `const seats = require('./seats');`, add the `store` parameter, and change the token route's two seat checks:

```js
function meetingsRouter(db, livekit, limiter, store) {
```

```js
    const seat = store ? await store.seatFor(id, req.userId) : null;
    if (!seat) return res.status(403).json({ error: 'You do not hold a seat in this meeting.' });
```

```js
    if (!(await store.seatFor(id, req.userId))) return res.status(403).json({ error: 'You do not hold a seat in this meeting.' });
```

`server/lib/webhook.js`: delete `const seats = require('./seats');` and take the store:

```js
function livekitWebhook(livekit, store) {
```

```js
      // No store means no rooms at all, so nobody holds a seat.
      if (isValidCode(meetingId) && userId && !(store && (await store.hasSeat(meetingId, userId)))) {
        livekit.evict(meetingId, userId); // never rejects: see lib/livekit.js
      }
```

`server/app.js`: add `store = null` to the `createApp` parameters and pass it on:

```js
  if (livekit) app.use(livekitWebhook(livekit, store));
```

```js
  if (db) app.use('/api', meetingsRouter(db, livekit, limiter, store));
```

- [ ] **Step 4: Create the store in `server/server.js`**

```js
const { randomUUID } = require('node:crypto');
const { createRoomStore } = require('./lib/roomStore');
```

After the limiter is created:

```js
  // One id per process: seats and the screen lock record which server holds them.
  const store = redis ? createRoomStore(redis, { serverId: randomUUID() }) : null;
```

In the schema `try` block, change `await closeStaleMeetings(db);` to:

```js
      if (store) await closeStaleMeetings(db, store);
```

Pass `store` to `createApp({ ... })`, and replace the room registration:

```js
  if (db && store) registerRoomHandlers(io, { db, livekit, store });
  else console.warn('WARNING: DATABASE_URL or REDIS_URL is not set — ZyloRoom sockets will refuse every join request.');
```

- [ ] **Step 5: Store-backed test helpers**

In `server/test/helpers.js`:

1. Delete `const seats = require('../lib/seats');` and add `const { createRoomStore } = require('../lib/roomStore');`.
2. Split `setupTestRedis` so room servers can close their own connection after their sockets:

```js
// A clean Redis connection the caller closes: database 1, emptied first.
async function connectTestRedis() {
  const redis = createRedis(process.env.TEST_REDIS_URL || 'redis://localhost:6379/1', { log: quietLog });
  await whenReady(redis);
  await redis.flushdb();
  return redis;
}

// The same, closed when the test ends.
async function setupTestRedis(t) {
  const redis = await connectTestRedis();
  t.after(() => redis.quit());
  return redis;
}
```

3. Replace `startRoom` with a seeding step and a server step:

```js
async function seedMeeting(
  db,
  { meetingId = 'abc-defg-hij', admission = 'auto', screenSharePolicy = 'anyone', maxParticipants = 3, mode = 'standard' } = {},
) {
  await insertUser(db, { id: 'host', email: 'host@zylo.test', name: 'Hana Host' });
  await insertUser(db, { id: 'p1', email: 'p1@zylo.test', name: 'Priya One' });
  await insertUser(db, { id: 'p2', email: 'p2@zylo.test', name: 'Pablo Two' });
  await insertUser(db, { id: 'p3', email: 'p3@zylo.test', name: 'Pia Three' });
  await insertMeeting(db, { id: meetingId, hostId: 'host', admission, screenSharePolicy, maxParticipants, mode });
  return meetingId;
}

// A Socket.IO server running the real room handlers on a room store. graceMs is
// short so grace expiry is testable. close() lets in-flight disconnect handling
// finish, stops the handlers' timers, then closes the server.
async function startRoomServer(db, redis, { serverId = 'server-a', graceMs = 60, livekit = null } = {}) {
  const store = createRoomStore(redis, { serverId });
  let handlers;
  const server = await startSocketServer((io) => {
    io.use(fakeSocketAuth);
    handlers = registerRoomHandlers(io, { db, graceMs, livekit, store });
  });
  return {
    url: server.url,
    store,
    handlers,
    close: async () => {
      await settle();
      handlers.stop();
      await server.close();
    },
  };
}

// The four users, one meeting, and a room server. Brings its own Redis (closed by
// server.close()) unless one is passed in.
async function startRoom(db, { redis, serverId, graceMs = 60, livekit = null, ...meeting } = {}) {
  const ownRedis = !redis;
  const conn = redis ?? (await connectTestRedis());
  const meetingId = await seedMeeting(db, meeting);
  const room = await startRoomServer(db, conn, { serverId, graceMs, livekit });
  const close = async () => {
    await room.close();
    if (ownRedis) await conn.quit();
  };
  return { meetingId, server: { url: room.url, close }, store: room.store, handlers: room.handlers };
}
```

4. In `roomHarness`, take `store` from `startRoom`, drop the `seats.clearMeeting(meetingId)` call and its comment (the server's `close()` now stops the timers), and return `store`:

```js
async function roomHarness(t, options = {}) {
  const db = await setupTestDb();
  const livekit = recordingLivekit();
  const { meetingId, server, store } = await startRoom(db, { ...options, livekit });
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await server.close();
    await db.close();
  });
  const connect = (userId) => { const c = connectClient(server.url, userId); clients.push(c); return c; };
  const join = async (userId) => { const c = await seat(server.url, userId, meetingId); clients.push(c); return c; };
  return { db, livekit, meetingId, server, store, connect, join };
}
```

5. Add:

```js
// Another tab taking this user's seat, as the real join path does it.
async function takeOverSeat(store, meetingId, userId, socketId) {
  const s = await store.seatFor(meetingId, userId);
  return store.join(meetingId, { userId, socketId, name: s.name, imageUrl: s.imageUrl, lang: s.lang }, { isHost: s.isHost });
}

// A seat with no socket server behind it, for HTTP routes that only read the store.
async function seatInStore(store, meetingId, { userId, socketId = `${userId}-socket`, name = userId, isHost = false }) {
  await store.initMeta(meetingId, {
    hostId: isHost ? userId : 'host', admission: 'auto', screenSharePolicy: 'anyone', maxParticipants: 20, mode: 'standard',
  });
  return store.join(meetingId, { userId, socketId, name, imageUrl: null, lang: null }, { isHost });
}
```

6. Export `connectTestRedis`, `seedMeeting`, `startRoomServer`, `takeOverSeat`, `seatInStore` alongside the existing names.

- [ ] **Step 6: Move the existing tests onto the store**

These are every line that touched `seats` (found with `grep -n "seats\." server/test/*.js`). Apply the mapping; the assertions themselves don't change.

| Old | New |
|---|---|
| `seats.hasSeat(m, u)`, `seats.seatFor(m, u)`, `seats.listSeats(m)`, `seats.queuedEntries(m)`, `seats.queueSocketId(m, u)`, `seats.screenSharer(m)` | the same call as `await store.<name>(...)` |
| `seats.releaseScreenLock(m, id)` | `await store.releaseScreenLock(m, id)` |
| `seats.releaseSeat(m, u, { immediate: true })` | `await store.releaseSeat(m, u)` |
| `const seat = seats.seatFor(m, 'p1'); seats.tryTakeSeat(m, { ...seat, socketId: 'synthetic-other-tab', ... })` | `await takeOverSeat(store, m, 'p1', 'synthetic-other-tab')` |
| `seats.tryTakeSeat(ID, { userId, socketId, name, imageUrl, isHost, max })` (HTTP tests) | `await seatInStore(store, ID, { userId, socketId, name, isHost })` |
| `seats.clearMeeting(...)` in a teardown | delete the line (`server.close()` or the test's Redis teardown now covers it) |

Where each file gets `store`:
- `host.test.js`, `screen.test.js`, `captions.test.js`, `translator.test.js`: destructure `store` from `roomHarness(t)` (or from `startRoom(...)` where a test calls it directly). Delete `require('../lib/seats')`.
- `room.test.js`: replace the body of its `scenario(db, opts)` with `return startRoom(db, opts);` (the users, meeting and grace are identical), destructure `store` wherever a test reads seats, delete `require('../lib/seats')`, and delete `registerRoomHandlers` from its `require('../lib/room')` if nothing else uses it. Its `closeStaleMeetings` test calls `closeStaleMeetings(db, store)` with a store from `createRoomStore(await setupTestRedis(t), { serverId: 'boot' })`.
- `livekit.test.js`, `webhook.test.js`: each test that seats someone creates `const store = createRoomStore(await setupTestRedis(t), { serverId: 'test' });` and passes `store` into its `createApp({ ... })` (for `webhook.test.js`, into `livekitWebhook(livekit, store)` or `createApp`, whichever it builds). Require `createRoomStore` and the helpers you use.

Line list to cover (from the grep): `host.test.js` 65, 66, 111, 148, 167, 193, 223, 253, 272, 295, 306, 320, 335, 378; `livekit.test.js` 232-235, 249-252, 265-268, 275-278, 290-293, 426, 431, 433; `room.test.js` 43, 87, 125, 147, 150, 160, 177, 182, 192, 210, 234, 266, 267, 282, 339, 367, 368, 379, 415, 430, 480, 525, 592, 630, 668, 669, 706, 761, 780-789, 807; `webhook.test.js` 88-89; `screen.test.js` 14, 25, 49, 86, 99-100, 114, 129, 143, 157, 213, 220, 231; `captions.test.js` 149-159, 287; `translator.test.js` 32, 55, 113, 128, 178, 201-211, 218, 233.

- [ ] **Step 7: Delete the in-memory store**

```bash
git rm server/lib/seats.js server/test/seats.test.js
```

Run: `grep -rn "seats'" server/lib server/test`
Expected: no output.

- [ ] **Step 8: Run everything**

Run: `cd server && node --test test/ownership.test.js test/roomStore.test.js`
Expected: all pass.

Run: `cd server && npm test`
Expected: all pass. A failure here is a behaviour change: fix `room.js`, not the old test's assertion. (Timing-sensitive tests that `settle()` for 60 ms may need `settle(120)` now that store calls are round trips; that is the only kind of test edit allowed beyond the mapping above.)

- [ ] **Step 9: Mutation checks**

Make each change, run `node --test test/ownership.test.js test/room.test.js`, see a failure, undo:
1. In `meeting:leave`, call `freeSeat(meetingId, userId)` without `socket.id` (the replaced-tab leave test fails).
2. In `hostGuard`, drop `|| seat.socketId !== socket.id` (the replaced-host test fails).
3. In `admit`, delete the `broadcastPresence(meetingId, socketId)` line (the "roster straight after being admitted" test fails).
4. In `disconnect`, start the grace timer without awaiting `markGrace` (a grace-period test in `room.test.js` fails or turns flaky).

- [ ] **Step 10: Commit**

```bash
git add server/lib/room.js server/lib/meetings.js server/lib/webhook.js server/app.js server/server.js server/test/helpers.js server/test/ownership.test.js server/test/room.test.js server/test/host.test.js server/test/screen.test.js server/test/captions.test.js server/test/translator.test.js server/test/livekit.test.js server/test/webhook.test.js
git commit -m "feat(server): rooms on the Redis store; handlers check socket ownership; seats.js removed"
```

### Task 10: Many servers: the adapter, heartbeats and the sweeper

**Files:**
- Modify: `server/package.json` (add `@socket.io/redis-adapter`)
- Modify: `server/lib/room.js` (heartbeat, `sweep`, options `sweepMs` and `idleRoomMs`; `closeStaleMeetings` removed)
- Modify: `server/server.js` (adapter; no boot clean-up)
- Modify: `server/test/helpers.js` (`startRoomServer` gains `adapter`; `twoServerHarness`)
- Modify: `server/test/room.test.js` (delete the `closeStaleMeetings` test; the sweep test below replaces it)
- Create: `server/test/multiServer.test.js`

**Interfaces:**
- Consumes: everything from Tasks 8 and 9.
- Produces: `registerRoomHandlers(io, { db, store, livekit, graceMs, sweepMs = 15000, idleRoomMs = 60000 }) → { stop(), sweep() }` (`sweepMs: 0` starts no timers; `sweep()` runs one pass and never rejects); test helper `twoServerHarness(t, meeting = {}) → { db, redis, livekit, meetingId, a, b }` where `a` and `b` each have `{ url, store, handlers, connect(userId), join(userId) }`.

- [ ] **Step 1: Install the adapter**

Run: `npm --prefix server install @socket.io/redis-adapter@^8`
Expected: `server/package.json` lists it under `dependencies`.

- [ ] **Step 2: The two-server harness**

In `server/test/helpers.js`, add `const { createAdapter } = require('@socket.io/redis-adapter');`, and change `startRoomServer` so it can use the adapter and never starts the sweep timers in tests (tests call `handlers.sweep()` themselves):

```js
async function startRoomServer(db, redis, { serverId = 'server-a', graceMs = 60, livekit = null, adapter = false } = {}) {
  const store = createRoomStore(redis, { serverId });
  // The adapter's own connections, with the offline queue on (as in server.js).
  const pubsub = adapter
    ? [redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null }), redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null })]
    : [];
  let handlers;
  const server = await startSocketServer((io) => {
    if (adapter) io.adapter(createAdapter(pubsub[0], pubsub[1]));
    io.use(fakeSocketAuth);
    handlers = registerRoomHandlers(io, { db, graceMs, livekit, store, sweepMs: 0 });
  });
  return {
    url: server.url,
    store,
    handlers,
    close: async () => {
      await settle();
      handlers.stop();
      await server.close();
      await Promise.all(pubsub.map((c) => c.quit()));
    },
  };
}
```

Add (and export):

```js
// Two room servers sharing one Redis and one database, like two API servers behind a
// load balancer. A client picks its server by which one it connects to.
async function twoServerHarness(t, meeting = {}) {
  const db = await setupTestDb();
  const redis = await connectTestRedis();
  const livekit = recordingLivekit();
  const meetingId = await seedMeeting(db, meeting);
  const a = await startRoomServer(db, redis, { serverId: 'server-a', livekit, adapter: true });
  const b = await startRoomServer(db, redis, { serverId: 'server-b', livekit, adapter: true });
  await Promise.all([a.store.beat(), b.store.beat()]);
  await settle(200); // let both adapters' subscriptions land
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.disconnect());
    await a.close();
    await b.close();
    await redis.quit();
    await db.close();
  });
  const clientsOf = (server) => ({
    connect: (userId) => {
      const c = connectClient(server.url, userId);
      clients.push(c);
      return c;
    },
    join: async (userId) => {
      const c = await seat(server.url, userId, meetingId);
      clients.push(c);
      return c;
    },
  });
  return { db, redis, livekit, meetingId, a: { ...a, ...clientsOf(a) }, b: { ...b, ...clientsOf(b) } };
}
```

- [ ] **Step 3: Write the failing multi-server tests**

Create `server/test/multiServer.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRoomStore } = require('../lib/roomStore');
const { twoServerHarness, waitForEvent, collect, settle } = require('./helpers');

test('chat sent on one server reaches people on the other', async (t) => {
  const { a, b } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const got = waitForEvent(p1, 'chat:message');
  host.emit('chat:message', { text: 'hello from server A' });
  assert.equal((await got).text, 'hello from server A');
});

test('two joins on different servers race for the last seat: exactly one gets it', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t); // max 3: the host + 2
  await a.join('host');
  await b.join('p1');
  const c2 = a.connect('p2');
  const c3 = b.connect('p3');
  await Promise.all([waitForEvent(c2, 'connect'), waitForEvent(c3, 'connect')]);
  const outcome = (c) =>
    Promise.race([
      waitForEvent(c, 'meeting:admitted').then(() => 'admitted'),
      waitForEvent(c, 'meeting:waiting').then(() => 'waiting'),
    ]);
  const results = Promise.all([outcome(c2), outcome(c3)]);
  c2.emit('meeting:join-request', { meetingId });
  c3.emit('meeting:join-request', { meetingId });
  assert.deepEqual((await results).sort(), ['admitted', 'waiting']);
});

test('a host on one server removes someone on the other', async (t) => {
  const { a, b, meetingId, livekit } = await twoServerHarness(t);
  const host = await a.join('host');
  const p1 = await b.join('p1');
  const removed = waitForEvent(p1, 'meeting:removed');
  host.emit('host:kick', { userId: 'p1' });
  await removed;
  await settle(150);
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), false);
  assert.deepEqual(livekit.callsTo('evict'), [[meetingId, 'p1']]);
});

test('the host admits someone waiting on the other server, who then gets the roster', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t, { admission: 'manual' });
  const host = await a.join('host');
  const waiter = b.connect('p1');
  const waiting = waitForEvent(waiter, 'meeting:waiting');
  waiter.emit('meeting:join-request', { meetingId });
  await waiting;
  const admitted = waitForEvent(waiter, 'meeting:admitted');
  const presence = waitForEvent(waiter, 'room:presence');
  const ack = new Promise((resolve) => host.emit('lobby:admit', { userId: 'p1' }, resolve));
  assert.deepEqual(await ack, { ok: true });
  await admitted;
  assert.deepEqual((await presence).people.map((p) => p.userId).sort(), ['host', 'p1']);
});

test('a replaced host tab on the other server keeps no host powers', async (t) => {
  const { a, b, meetingId, livekit } = await twoServerHarness(t);
  const tabA = await a.join('host');
  await a.join('p1');
  const tabB = b.connect('host');
  const admitted = waitForEvent(tabB, 'meeting:admitted');
  tabB.emit('meeting:join-request', { meetingId });
  await admitted;
  const forbidden = collect(tabA, 'error:forbidden');
  tabA.emit('host:mute', { userId: 'p1' });
  await settle(150);
  assert.equal(forbidden.length, 1);
  assert.equal(livekit.callsTo('muteMic').length, 0);
});

test('dropping off one server and coming back on the other keeps the seat', async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t);
  await a.join('host');
  const first = await a.join('p1');
  first.disconnect();
  await settle(20);
  await b.join('p1');
  await settle(150); // past the 60 ms grace server A started
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true);
});

test("a crashed server's seat is held for the grace period, then freed by the sweep", async (t) => {
  const { a, meetingId, redis } = await twoServerHarness(t);
  const host = await a.join('host');
  // A seat held on a server that died: no heartbeat for it exists.
  const ghost = createRoomStore(redis, { serverId: 'crashed-server' });
  await ghost.join(meetingId, { userId: 'p1', socketId: 'socket-on-a-dead-server', name: 'Priya One', imageUrl: null, lang: null }, { isHost: false });
  const presence = collect(host, 'room:presence');
  await a.handlers.sweep(); // stamps the grace period
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true, 'held while they might come back');
  await settle(100); // graceMs is 60 in tests
  await a.handlers.sweep(); // releases it
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), false);
  await settle(50);
  assert.deepEqual(presence.at(-1).people.map((p) => p.userId), ['host']);
});

test("a live server's seats are left alone by the other server's sweep", async (t) => {
  const { a, b, meetingId } = await twoServerHarness(t);
  await a.join('host');
  await b.join('p1');
  await a.handlers.sweep();
  await settle(100);
  await a.handlers.sweep();
  assert.equal(await a.store.hasSeat(meetingId, 'p1'), true);
  assert.equal((await a.store.seatFor(meetingId, 'p1')).graceUntil, undefined);
});

test('a meeting live in Postgres but held by no server is ended by the sweep', async (t) => {
  const { a, db, meetingId } = await twoServerHarness(t);
  await db.query('UPDATE meetings SET started_at = now() WHERE id = $1', [meetingId]);
  await a.handlers.sweep();
  const { rows } = await db.query('SELECT ended_at FROM meetings WHERE id = $1', [meetingId]);
  assert.notEqual(rows[0].ended_at, null);
});
```

- [ ] **Step 4: Run them to see them fail**

Run: `cd server && node --test test/multiServer.test.js`
Expected: the three sweep tests FAIL with `handlers.sweep is not a function`. The other six may already pass, because the harness wires the adapter and Task 9 made every handler reach sockets by id; they stay as the regression tests for running on many servers. If any of those six fails, fix `room.js` before going on.

- [ ] **Step 5: Heartbeat and sweeper in `server/lib/room.js`**

Add below the `roomChannel` line:

```js
const SWEEP_MS = 15_000;
const HEARTBEAT_MS = 10_000;
const IDLE_ROOM_MS = 60_000;
```

Change the signature:

```js
function registerRoomHandlers(
  io,
  { db, store, livekit = null, graceMs = GRACE_MS, sweepMs = SWEEP_MS, idleRoomMs = IDLE_ROOM_MS },
) {
```

Add just before `io.on('connection', ...)`:

```js
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
    for (const meetingId of await store.liveMeetings()) {
      if (!(await store.getMeta(meetingId))) {
        await store.forgetLive(meetingId);
        continue;
      }
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
      for (const entry of await store.queuedEntries(meetingId)) {
        if ((await gone(entry)) && (await store.removeFromQueue(meetingId, entry.userId, entry.socketId))) lobbyChanged = true;
      }
      const sharer = await store.screenSharer(meetingId);
      if (sharer && (await gone(sharer))) await releaseScreen(meetingId, sharer.socketId);
      if (seatFreed) await onSeatFreed(meetingId);
      else if (lobbyChanged) await broadcastLobby(meetingId);
      else if (await store.clearIfIdle(meetingId, idleRoomMs)) await markEnded(meetingId);
    }
    // Live in Postgres but held by no server: a crash, or Redis lost its data.
    const { rows } = await db.query('SELECT id FROM meetings WHERE started_at IS NOT NULL AND ended_at IS NULL');
    if (rows.length === 0) return;
    const live = new Set(await store.liveMeetings());
    for (const { id } of rows) if (!live.has(id)) await markEnded(id);
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
      if (!sweepFailing) console.error('room sweep failed:', err.message); // once per outage
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
```

Replace the returned object:

```js
  return {
    sweep: runSweep,
    // Cancels timers and pending grace periods, and starts no new ones (tests; shutdown later).
    stop() {
      stopped = true;
      timers.forEach((timer) => clearInterval(timer));
      for (const timer of graceTimers) clearTimeout(timer);
      graceTimers.clear();
    },
  };
```

Delete `closeStaleMeetings` (function and export): the sweep replaces it. `module.exports = { registerRoomHandlers, roomChannel };`

- [ ] **Step 6: The adapter in `server/server.js`, and no boot clean-up**

```js
const { createAdapter } = require('@socket.io/redis-adapter');
```

Right after `const io = new Server(...)`:

```js
  if (redis) {
    // Two connections of its own with the offline queue on: the adapter subscribes at
    // start-up and must not fail just because Redis isn't connected yet. redis.js
    // already reports outages, so their errors are not logged again.
    const pub = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    const sub = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
    pub.on('error', () => {});
    sub.on('error', () => {});
    io.adapter(createAdapter(pub, sub));
  }
```

Delete the `closeStaleMeetings` import and its call in the schema `try` block (keep applying `schema.sql`). Delete the old comment about "A crash leaves meetings marked live".

In `server/test/room.test.js`, delete the test that calls `closeStaleMeetings` and the import; `multiServer.test.js`'s last test covers that job now.

- [ ] **Step 7: Run everything**

Run: `cd server && node --test test/multiServer.test.js`
Expected: all 9 pass.

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 8: Mutation checks**

Make each change, run `node --test test/multiServer.test.js`, see a failure, undo:
1. In `sweep`, make `gone` always return `false` (the crashed-server test fails).
2. Make `gone` always return `true` (the "live server's seats are left alone" test fails).
3. Delete the Postgres block at the end of `sweep` (the last test fails).
4. In the helper, pass `adapter: false` for both servers (the chat, kick and admit tests fail).

- [ ] **Step 9: Commit**

```bash
git add server/package.json server/package-lock.json server/lib/room.js server/server.js server/test/helpers.js server/test/room.test.js server/test/multiServer.test.js
git commit -m "feat(server): Socket.IO Redis adapter, server heartbeats, and a sweeper for crashed servers"
```

### Task 11: When Redis is down, rooms fail closed

**Files:**
- Modify: `server/lib/room.js` (the join handler turns a store error into `unavailable`)
- Create: `server/test/redisDown.test.js`
- Modify: `web/lib/use-meeting.ts` (`DeniedReason` gains `'unavailable'`)
- Modify: `web/components/meeting-room-flow.tsx` (its copy)

**Interfaces:**
- Consumes: `startRoomServer`, `seedMeeting` (Task 9 and 10 helpers); `createRedis`, `quietLog`.
- Produces: the server event `meeting:denied { reason: 'unavailable' }`; `DeniedReason = 'not_found' | 'ended' | 'removed' | 'denied' | 'full' | 'unavailable'`.

- [ ] **Step 1: Write the failing test**

Create `server/test/redisDown.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRedis } = require('../lib/redis');
const { setupTestDb, seedMeeting, startRoomServer, connectClient, waitForEvent, quietLog } = require('./helpers');

test('with Redis unreachable, a join is refused as unavailable and never admitted', async (t) => {
  const db = await setupTestDb();
  const deadRedis = createRedis('redis://127.0.0.1:6390', { log: quietLog }); // nothing listens here
  const meetingId = await seedMeeting(db);
  const room = await startRoomServer(db, deadRedis);
  const client = connectClient(room.url, 'host');
  t.after(async () => {
    client.disconnect();
    await room.close();
    deadRedis.disconnect();
    await db.close();
  });
  const admitted = [];
  client.on('meeting:admitted', () => admitted.push(true));
  const denied = waitForEvent(client, 'meeting:denied');
  client.emit('meeting:join-request', { meetingId });
  assert.deepEqual(await denied, { reason: 'unavailable' });
  assert.deepEqual(admitted, []);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd server && node --test test/redisDown.test.js`
Expected: FAIL: the test times out waiting for `meeting:denied` (the handler's error is only logged today).

- [ ] **Step 3: Turn a failed join into `unavailable`**

In `server/lib/room.js`, move everything in the `meeting:join-request` handler after the `typeof meetingId !== 'string'` check into a new function inside `registerRoomHandlers`, above `io.on('connection', ...)`:

```js
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
    await broadcastPresence(meetingId);
    // A host arriving needs to see whoever is already waiting for them.
    if (isHostUser) await broadcastLobby(meetingId);
  }
```

and make the handler:

```js
    on(socket, 'meeting:join-request', async ({ meetingId, lang } = {}) => {
      if (!allowEvent(socket, 'meeting:join-request')) return socket.emit('rate-limited', { event: 'meeting:join-request' });
      if (typeof meetingId !== 'string') return socket.emit('meeting:denied', { reason: 'not_found' });
      try {
        await joinMeeting(socket, meetingId, lang);
      } catch (err) {
        // The store or the database can't be read: never admit anyone blind.
        console.error('join failed:', err.message);
        socket.emit('meeting:denied', { reason: 'unavailable' });
      }
    });
```

Every other handler already fails closed: its store read throws, the `on()` wrapper logs it, and nothing is relayed or changed.

- [ ] **Step 4: Run the server tests**

Run: `cd server && node --test test/redisDown.test.js`
Expected: PASS.

Run: `cd server && npm test`
Expected: all pass.

- [ ] **Step 5: Show it in the web app**

In `web/lib/use-meeting.ts`, extend the type (and its comment):

```ts
// 'full' is Translator Convo only: a 2-seat link that's already taken. 'unavailable':
// the server couldn't read its live room state (Redis), so it admitted nobody.
export type DeniedReason = 'not_found' | 'ended' | 'removed' | 'denied' | 'full' | 'unavailable';
```

In `web/components/meeting-room-flow.tsx`, add to `DENIED_COPY`:

```ts
  unavailable: {
    title: 'Meetings are unavailable for a moment',
    text: 'Zylo couldn’t reach its meeting service. Reload this page in a few seconds to try again.',
  },
```

Run: `cd web && npm test && npx tsc --noEmit && npm run lint`
Expected: all pass (`tsc` fails if `DENIED_COPY` misses the new reason, which is the point of the `Record` type).

- [ ] **Step 6: Mutation check and commit**

Replace the `catch` body with `throw err;`, run `node --test test/redisDown.test.js`, see it fail, undo.

```bash
git add server/lib/room.js server/test/redisDown.test.js web/lib/use-meeting.ts web/components/meeting-room-flow.tsx
git commit -m "feat: rooms fail closed when Redis is down; the web app says so"
```

---

### Task 12: Verify 7b end to end

**Files:**
- Modify: whatever the review in Step 4 finds; `docs/architecture.md` (Step 5).

- [ ] **Step 1: Every automated check**

Run from the repo root: `npm run db:up`
Run: `cd server && npm test`
Run: `cd web && npm test && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass; the build succeeds.

- [ ] **Step 2: A real meeting on Redis**

Start LiveKit (`npm run livekit`) and the app (`npm run dev`). In two browsers (two accounts), create a meeting with manual admission, join, admit from the lobby, chat, share a screen, remove the guest, rejoin as the guest (refused), then end the meeting.

While it's running: `docker compose exec redis redis-cli --scan --pattern 'zylo:room:*'`
Expected: the meeting's `meta`, `seats`, `seq` (and `queue`/`screen`/`removed` while in use).

After "End for all": the same scan shows only `zylo:room:{<code>}:ended`.

- [ ] **Step 3: Restarts and outages**

1. During a call, restart the API server (Ctrl+C, `npm run dev:server`). Expected: both browsers reconnect by themselves within seconds and keep their seats; the meeting is not ended.
2. During a call, `docker compose stop redis`. Expected: audio and video keep working; chat and captions stop; a third person trying to join sees "Meetings are unavailable for a moment". `docker compose start redis`: chat works again, and the third person can join after reloading.
3. Kill the API server while two people are in a call and don't restart it for 60 s, then start it. Expected: within about 45 s of it coming back (heartbeat 30 s + sweep 15 s), seats whose browsers didn't reconnect are released and a fully abandoned meeting shows as ended on the dashboard.

- [ ] **Step 4: Review the whole 7b diff**

Run `/code-review high` on the 7b commits: `git log --oneline` shows them starting at "room store in Redis"; review `git diff <that commit's hash>~1..HEAD`. Fix every correctness finding with a test where it's a behaviour, re-run Step 1, commit with specific file names.

- [ ] **Step 5: Docs and hand-off**

In `docs/architecture.md`, change the "Ephemeral state" row of the stack table to say room state is in Redis (seats, lobby, screen lock via Lua scripts; Socket.IO Redis adapter; heartbeat and sweeper), and the per-process caveat about seats to point at `server/lib/roomStore.js`.

Commit the docs. Report to the user: what was built, the test counts, what Step 3 showed, and anything skipped. Don't push unless asked; deployment is 7c.

