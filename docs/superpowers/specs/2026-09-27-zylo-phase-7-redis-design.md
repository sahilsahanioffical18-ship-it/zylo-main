# Zylo Phase 7: Redis, rate limits and rooms on many servers

Approved in chat on 2026-09-27. Implemented by two plans, run in order:

- **7a** `docs/superpowers/plans/2026-09-27-zylo-phase-7a.md`: Redis, rate limits everywhere, the translation cache in Redis. Still one API server; everything shared already works for many.
- **7b** `docs/superpowers/plans/2026-09-27-zylo-phase-7b.md`: seats, lobby and the screen-share lock move to Redis, plus the Socket.IO Redis adapter, so several API servers can run side by side.

Out of scope (a later 7c): deployment, graceful shutdown, structured logs, the 20-person load test.

Starts only after Phase 6 is approved and merged; build on a fresh `phase-7-redis` worktree off `main`.

---

## 1. What gets protected

Zylo has no login or search routes: Clerk hosts sign-in (and rate-limits it), and nothing searches. The real targets:

| Risk | Target | Why |
|---|---|---|
| High: money or an outside service | `/api/tts`, `/api/translate` (cache misses only), `GET /api/meetings/:id/livekit-token`, Phase 8 `ai:message` | Google blocks our IP, LiveKit room calls pile up, a Grok bill |
| High: floods before sign-in | every HTTP request and every socket connection, per IP | Bad tokens still cost work; reconnect storms hit every server |
| Medium: creates data or spam | `POST /api/meetings`, `chat:message`, `meeting:join-request` | Meeting spam, chat floods |
| Medium: code guessing | `GET /api/meetings/:id`, `meeting:join-request` | 26^10 codes make guessing impractical; the limit is nearly free |
| Low | host actions, `screen:request`, `convo:set-lang`, `/health` | A buggy client looping |
| Never limited | `POST /livekit/webhook` | Signed already; dropping one could leave a removed person in the room |

## 2. The algorithm and where limits live

One algorithm everywhere: a **token bucket**. A bucket holds up to `burst` tokens, refills at `rate` tokens a second, and each call spends one. Short bursts pass; the average can't exceed `rate`. It is the algorithm captions and the Google proxy already use.

- **Shared limits** (per IP, per user, whole deployment) run as one **Redis Lua script**, so two servers can never both spend the last token. The script uses Redis's clock (`TIME`), so servers with slightly different clocks don't matter. Tests may pass a clock in as an extra argument.
- **Per-socket event limits** stay in memory on the socket: a socket lives on one server for its whole life, so Redis would only add a round trip to the busiest path (captions). The per-IP connection limit stops a reconnect from buying a fresh bucket.
- Rejected alternatives: `rate-limiter-flexible` (a dependency to explain; fixed window by default, which lets twice the limit through around the reset) and `express-rate-limit` + a Redis store (HTTP only, so two systems).

### The numbers (all in `server/lib/rateLimit.js`)

Shared, in Redis (`POLICIES`):

| Policy | Key id | Rate /s | Burst | Used by |
|---|---|---|---|---|
| `ip` | client IP | 10 | 60 | every HTTP request except the webhook, before auth |
| `api` | user id | 5 | 30 | every `/api` call, after auth |
| `create` | user id | 0.1 | 5 | `POST /api/meetings` |
| `lookup` | user id | 1 | 10 | `GET /api/meetings/:id` |
| `lkToken` | user id | 0.2 | 5 | `GET /api/meetings/:id/livekit-token` |
| `google` | user id | 2 | 10 | Google upstream calls (cache hits are free) |
| `googleAll` | `all` | 20 | 40 | Google upstream calls, whole deployment |
| `connect` | client IP | 1 | 10 | Socket.IO connections |
| `aiUser` | user id | 0.1 | 3 | Phase 8 `ai:message` (defined now, wired in Phase 8) |
| `aiRoom` | meeting code | 0.1 | 6 | Phase 8 `ai:message` per meeting |

Per socket, in memory (`SOCKET_POLICIES`):

| Event | Rate /s | Burst | When refused |
|---|---|---|---|
| `meeting:join-request` | 1 | 5 | `rate-limited` event |
| `chat:message` | 2 | 8 | `rate-limited` event |
| `convo:caption` | 8 | 12 | dropped silently (unchanged) |
| `convo:set-lang` | 1 | 3 | dropped silently |
| `screen:request` | 0.5 | 3 | `rate-limited` event |
| `host` (every `host:*` and `lobby:*` event shares it) | 2 | 10 | `rate-limited` event |

### What the client sees

- HTTP: `429` with `Retry-After` (whole seconds) and `{ error: "Too many requests. Try again in N s.", retryAfterMs }`. Every limited response carries `RateLimit-Remaining`. CORS lists both headers in `exposedHeaders` so the browser can read them. `useApi` already shows `error` from the body.
- Sockets: `rate-limited` `{ event }`; the web app shows a toast worded for that event.
- A refused socket connection gets a `connect_error` with `data.retryAfterMs`; socket.io never retries a middleware refusal on its own, so the client calls `socket.connect()` after that wait.
- Real client IPs: `app.set('trust proxy', TRUST_PROXY)`; `TRUST_PROXY` is the number of proxy hops (0 locally, 1 behind Railway or Fly). Sockets read `X-Forwarded-For` with the same hop count.

## 3. Redis setup

- Client: `ioredis`. The main connection has no offline queue (`enableOfflineQueue: false`), `maxRetriesPerRequest: 1` and a 500 ms `commandTimeout`, so commands fail fast while Redis is down and callers fall back at once. It reconnects forever, backing off up to 5 s. Outages and recoveries are logged once each.
- The Socket.IO adapter (7b) uses two duplicates of that connection **with** the offline queue on, so its subscribe never fails before the first connect.
- Config: `REDIS_URL` (`rediss://` in production). Local Redis runs in Docker Compose beside Postgres; `npm run db:up` starts both. Tests use database 1 (`TEST_REDIS_URL`, default `redis://localhost:6379/1`) and `FLUSHDB` before each test.
- Memory: `maxmemory 256mb`, `maxmemory-policy volatile-lru`. Only keys with a TTL can be evicted, so under pressure Redis drops cache entries and rate buckets (a dropped bucket just starts full), never room state.

### Key names (everything starts with `zylo:`)

| Key | Type | TTL |
|---|---|---|
| `zylo:rl:<policy>:<id>` | hash `{tokens, at}` | time to refill fully (burst / rate) + 1 s |
| `zylo:cache:<tts\|tr>:<sha1 of the cache key>` | string (bytes) | 24 h |
| `zylo:room:{<code>}:meta` | hash: hostId, admission, screenSharePolicy, maxParticipants, mode | none |
| `zylo:room:{<code>}:seats` | hash userId → seat JSON | none |
| `zylo:room:{<code>}:queue` | hash userId → lobby entry JSON | none |
| `zylo:room:{<code>}:screen` | string: sharer JSON | none |
| `zylo:room:{<code>}:removed` | set of user ids | none |
| `zylo:room:{<code>}:seq` | counter (join order) | none |
| `zylo:room:{<code>}:ended` | tombstone after a meeting ends | 1 h |
| `zylo:rooms:live` | set of live meeting codes | none |
| `zylo:server:<serverId>` | heartbeat | 30 s, refreshed every 10 s |

The braces around `<code>` are a Redis Cluster hash tag: all of one meeting's keys land together, so one Lua script may touch them all. No script touches `zylo:rooms:live`; it is updated right after, outside the script. Room keys have no TTL on purpose: they are deleted when the meeting ends, and the sweeper (section 5) catches leftovers.

## 4. Caching

- Moves to Redis: the translation and voice cache (`createRedisCache`), same async `get`/`set` as today's in-memory cache, so the routes don't change. Shared by every server, survives restarts. Values come back as bytes; the translate route calls `toString()`.
- A Redis error is a miss on `get` and a no-op on `set`.
- Not cached, on purpose: the dashboard (per user, changes often, already one query), meeting cards (must be fresh), Clerk token checks (already local).

## 5. Rooms on Redis (7b)

### Store

`server/lib/roomStore.js` replaces `server/lib/seats.js`. Same operation names, now `async`, each check-and-change one Lua script so the "no `await` between check and write" rule lives inside Redis:

- `join(meetingId, entry, { isHost })` → `{ result: 'seated' | 'queued' | 'full' | 'removed' | 'ended', replacedSocketId, position }`. One script decides everything the old handler decided after its last `await`: removed, ended, reconnect takeover, manual lobby, the host's reserved seat, a full translator convo, a full room's lobby.
- `admitFromQueue`, `drainQueue`, `releaseSeat` (optionally only if a given socket still owns it), `markGrace`, `releaseIfStale`, `removeFromQueue` (optionally socket-conditional), `setSeatLang` (socket-conditional), `takeScreenLock` (requires the seat), `releaseScreenLock`, `clearMeeting` (returns every socket id it dropped and leaves the 1 h tombstone), `initMeta` (refuses while the tombstone exists), `setMetaField`, `addRemoved`.
- Reads: `getMeta`, `seatFor`, `hasSeat`, `seatSocketId`, `listSeats` (in join order, by `seq`), `queuedEntries` (FIFO by `seq`), `queuePosition`, `queueSocketId`, `screenSharer`, `isRemovedLive`, `liveMeetings`.
- Seats and lobby entries record `serverId`; seats keep their original `seq` when a new tab takes them over, so the roster order never jumps.

### `room.js` changes

- Every seat/meta read or write goes through the store; `liveMeetings` and `meta.removed` are gone.
- Sockets on other servers: `io.to(id).emit(...)`, `io.in(id).socketsJoin(room)` / `socketsLeave(room)`, and `io.in(id).fetchSockets()` for "is it still connected?". These also work with the default in-memory adapter, so one server behaves exactly as before.
- `socket.data.meetingId` becomes a hint. Every handler that acts checks ownership in the store. Two handlers that didn't need to before now do: `meeting:leave` only frees the seat and lobby entry this socket owns, and `hostGuard` requires the host's seat to be held by this socket. Otherwise a replaced tab on another server could free the new tab's seat or keep host powers.
- An admitted socket gets the presence snapshot sent straight to it after `meeting:admitted`, because a cross-server `socketsJoin` may land after the room-wide broadcast. A duplicate snapshot is harmless.
- Grace: on disconnect, `markGrace` stamps `graceUntil` (Redis clock) on the seat only if this socket still owns it; the same server then sets a local timer (after the stamp, so it can't fire early) that calls `releaseIfStale`. A reconnect on any server clears the stamp, so the old timer does nothing.

### Heartbeat and sweeper

- Every server gets a random `serverId` at boot and refreshes `zylo:server:<serverId>` (30 s TTL) every 10 s.
- Every 15 s each server sweeps `zylo:rooms:live`:
  - a seat past `graceUntil` → `releaseIfStale`;
  - a seat whose socket is gone (its server's heartbeat expired, or it's our own server and the socket isn't connected) → `markGrace`, so it's released on a later sweep unless the person comes back;
  - lobby entries and the screen lock of gone sockets → removed (and the share revoked);
  - a room with no seats and no lobby → ended like the last person leaving.
- It also ends meetings Postgres says are live that aren't in `zylo:rooms:live`. This replaces `closeStaleMeetings` on boot, which would otherwise end other servers' meetings every time a server starts.
- Every step is conditional, so several servers sweeping at once is harmless.

### Adapter

`@socket.io/redis-adapter` so `io.to(room).emit` reaches sockets on every server.

## 6. When Redis is unavailable

| Part | Behaviour | Why |
|---|---|---|
| Rate limits | Fail open to per-server memory buckets, same numbers | A few minutes of weaker limits beats blocking everyone |
| Cache | Miss; Google calls stay within the memory budget | Slower, still correct |
| Rooms (7b) | Fail closed: a join gets `meeting:denied { reason: 'unavailable' }` ("Meetings are unavailable for a moment. Try again."); chat, captions and host actions are dropped | Permission checks never fail open |
| Media | Keeps working; LiveKit doesn't use Redis | People in a call keep seeing and hearing each other |
| Visibility | `/health` gains `redis`; one log line when an outage starts, one when it ends | |

No `REDIS_URL` in local development: limits and the cache run in memory (7a), and room sockets refuse joins with a startup warning (7b), matching how a missing database is handled.

## 7. Testing

- Tests first; each key guard gets a mutation check (break it, see a test fail, restore).
- 7a: every limiter behaviour runs against both memory and real Redis; two limiters on two connections share one budget; bucket keys get their TTL; a failing Redis falls back and warns once; 429s carry `Retry-After`, the JSON reason and `RateLimit-Remaining`; the webhook is never limited; trust proxy separates clients; socket connection and event limits; the Redis cache is shared, expires in a day, and treats errors as misses.
- 7b: `seats.test.js` ported to the store; 50 simultaneous `join`s for one seat give exactly one `seated`; every existing socket suite passes with store reads awaited; two real servers sharing Redis: chat crosses servers, a cross-server last-seat race, a host on one server removes a user on the other, a killed server's seats are freed by the sweep; Redis down means joins get `unavailable`.
