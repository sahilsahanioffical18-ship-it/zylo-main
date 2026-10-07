# Zylo Phase 10: ready to deploy (shutdown, connections, logs, load test, deploy guide)

Approved in chat on 2026-10-05. This is the work Phase 7 set aside as "7c" (master design, Phase 7: graceful shutdown, structured logs, the 15–20 person load test, deploy). Work happens in the `phase-10-deploy` worktree (`.worktrees/phase-10-deploy`), branched from `main` at 899b8b0 (Phases 1–9 merged).

Out of scope: actually deploying (the user creates the accounts and pastes the keys; Claude never enters credentials), keeping a screen share alive across a server restart, request logging, metrics dashboards, autoscaling rules, a load test against LiveKit Cloud or with real signed-in Chrome windows.

---

## 1. Decisions made with the user

| Question | Decision |
|---|---|
| What the server does when stopped | **Hand people over cleanly** (approach A): stop taking connections, stop timers and AI calls, drop connections so browsers reconnect, keep seats held in Redis, wait for that work, close, exit. |
| Connections | **WebSocket only**, in the browser and on the server, so several API servers work without sticky sessions. |
| Logs | **JSON lines in production** (`NODE_ENV=production`), the same readable text as today locally. No new dependency. |
| Load test | **Scripted, on this Mac**: LiveKit's `lk load-test` for video, and `npm run load-check` for Zylo's own server (20 simulated people on 2 API servers). Results in `LOAD_TEST_RESULTS.md`. |
| Deploy guide | `docs/deploy.md`: Vercel (web) + Railway (API, Postgres, Redis) + LiveKit Cloud + Clerk, with a post-deploy check. |

## 2. Stopping the server

On `SIGTERM` or `SIGINT`, once (a second signal while stopping is ignored), `server.js` runs `shutdown()` from `server/lib/shutdown.js`:

1. Log `shutting down` and stop accepting new HTTP requests and socket connections.
2. Call the room handlers' existing `stop()`: the heartbeat and sweep timers, the grace timers and the shared AI `AbortController`. An Ask AI answer in progress therefore ends with the normal `ai:failed` for the room; a nudge in progress posts nothing.
3. Close every client connection so that the browser **reconnects on its own**: the client must see a dropped transport (`transport close` or similar), never `io server disconnect`, which turns socket.io's automatic reconnection off.
4. Each closed socket runs the existing `disconnect` handler: it releases that page's screen share, removes it from the lobby and stamps `graceUntil` on its seat in Redis (`markGrace`, 30 s). Because the hold lives in Redis, it outlives this process: the person gets their seat back on whichever server they reconnect to, and if they don't return, any server's sweep frees it (`releaseIfStale`).
5. Wait for socket handlers still running. The existing `on` wrapper counts handlers in flight; `drain()` resolves when the count is 0. Wait at most **8 s**.
6. Close Redis (both the main client and the adapter's two) and the Postgres pool, log how long the stop took, and resolve to exit code 0.
7. A watchdog resolves to exit code 1 if the whole stop takes more than **10 s**.

`shutdown()` never calls `process.exit` itself: it resolves to the exit code, and `server.js` exits with it. That keeps it testable and lets the load test stop one of two in-process servers.

The heartbeat key is not deleted: its TTL lets it lapse on its own, and the seats are already held.

Known limitation (unchanged rule from Phase 4: a share never outlives its connection): a screen share in progress ends when the server stops; the presenter presses ZyloLive again.

## 3. Connections

- Web (`web/lib/use-meeting.ts`): `io(SERVER_URL, { transports: ['websocket'], … })`.
- Server (`server/server.js`): `new Server(httpServer, { transports: ['websocket'], cors: … })`, so a long-polling request is refused.
- With no HTTP long-polling there is no need for sticky sessions, so Railway may run more than one API replica (the Redis adapter, room store and sweeper already support several servers).
- Nothing is lost: LiveKit's signalling already needs WebSockets, so a network that blocks them couldn't hold a call anyway.

## 4. Logs

`server/lib/log.js` exports `createLog({ json, base })` → `{ info(msg, fields?), warn(msg, fields?), error(msg, fields?) }`, and a default instance configured from `NODE_ENV` (`json` when it is `production`).

- **JSON mode**: one line per call, `{"time":"<ISO 8601>","level":"info"|"warn"|"error","msg":"…",…base,…fields}`. `info` goes to stdout; `warn` and `error` to stderr. `base` carries `serverId` (the room store's per-process id) once it exists.
- **Text mode**: the same text the server prints today (`msg`, then any fields as `key=value`), through `console.log` / `console.warn` / `console.error`, so local output and the existing tests that capture log lines read the same.
- Every `console.*` call in `server/` (outside `test/`, about 24) moves to the logger. Where a meeting or a user is involved the call gains `meetingId` and `userId` fields; failed socket handlers also carry the event name; errors carry `err: err.message`.
- New `info` lines, only these:
  - server started: port, `serverId`, and whether AI, Redis and LiveKit are configured (booleans);
  - each shutdown step and the total time;
  - meeting ended: `meetingId` and `reason` (`host` | `empty` | `idle` | `stale`).
- **Never logged**: chat text, AI questions, answers or nudges, Clerk tokens, API keys or secrets, request bodies, provider response bodies beyond the short message Phase 8 already trims.

## 5. Load test

### 5.1 Video: `lk load-test`

- Tool: LiveKit CLI (`brew install livekit-cli`, command `lk`). Installing it downloads software, so Claude asks first, or the user runs it.
- Target: the local `livekit-server --dev` (`ws://127.0.0.1:7880`, `devkey` / `secret`).
- Run: one room, **20 participants: 5 publishing video + audio, 15 subscribing only**, for **2 minutes**.
- Recorded: connections that succeeded, video bitrate and packet loss as `lk` reports them, and `livekit-server`'s CPU and memory sampled every 5 s.
- Caveat written into the results: the load generator and the SFU share one Mac, so the numbers are a floor, not LiveKit Cloud's capacity.

### 5.2 Zylo's server: `npm run load-check`

`server/scripts/load-check.js`, run with `npm run load-check` in `server/` (not part of `npm test`). It reuses the test harness: two API servers in one process, sharing the real local Redis (database 1) and the test Postgres database, with the harness's fake sign-in (nothing in `server.js` changes for it), and a fake streaming AI.

1. **Join**: 20 simulated people join one meeting, 10 on each server. Record each person's time from `meeting:join-request` to `meeting:admitted`.
2. **Chat**: for 60 s, each person sends a line every 5–10 s, plus one burst where everyone sends at once. Every line must reach all 20 people; record delivery time (send → receive) for each line and receiver.
3. **Ask AI**: one person asks; the fake AI streams an answer; all 20 must receive `ai:done` exactly once.
4. **Speech reports**: every person sends `voice:activity` every 10 s throughout.
5. **Planned stop**: one server is stopped with `shutdown()`. Its 10 people reconnect (to the other server) and must be seated again with their seats kept. Record the time from the stop to the last of them being admitted.
6. **Cost**: Redis commands per minute (`INFO commandstats` before and after) and each server's memory (RSS) and CPU time.

Pass marks (the script prints PASS or FAIL for each, and exits non-zero on any FAIL):
- all 20 seated;
- no chat line lost;
- 95th-percentile chat delivery under **200 ms** locally;
- the stopped server's people seated again within **10 s**.

### 5.3 `LOAD_TEST_RESULTS.md`

At the repository root: how each test was run (commands), this Mac's model, CPU and memory, the numbers from both tests, the pass marks, anything that broke and what was done about it, and what the tests don't show (real internet conditions, LiveKit Cloud's limits, real browsers).

## 6. The deploy guide

`docs/deploy.md`, in order:

1. Prerequisites: `main` merged; accounts at Vercel, Railway and LiveKit Cloud; the Clerk app; the AI key.
2. **LiveKit Cloud**: create a project; copy URL (`wss://…livekit.cloud`), API key and secret.
3. **Railway**: deploy the repo with root directory `server` (`npm start`, Node 22 from `engines`); add PostgreSQL and Redis; variables `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `REDIS_URL=${{Redis.REDIS_URL}}`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `TRUST_PROXY=1`, `NODE_ENV=production`, `CLIENT_ORIGIN` (set in step 5); health check path `/health`; generate a domain; tables are created on start.
4. **Vercel**: import the repo with root directory `web`; Node 22.x comes from `engines: "22.x"` in `web/package.json`, which Vercel reads, so there is nothing to set; variables `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_SERVER_URL` (the Railway domain); optional `NEXT_PUBLIC_MYMEMORY_EMAIL`.
5. **Connect**: set `CLIENT_ORIGIN` on Railway to the exact Vercel URL (no trailing slash); preview URLs won't connect.
6. **LiveKit webhook**: `https://<api domain>/livekit/webhook`, signed with the same API key.
7. **Clerk**: development keys for a demo (development badge, usage limits) or a production instance (needs an owned domain, DNS records and Google sign-in credentials; then swap the keys in Vercel and Railway).
8. **Check**: `/health` shows `db`, `redis`, `livekit` and `ai` all true; a call between the Mac and a phone on mobile data; chat; Ask AI; a nudge; a redeploy mid-call keeps everyone in (the stop sequence).
9. **Replicas**: more than one API replica is supported (WebSocket only, Redis); start with one.
10. **Costs** (Vercel Hobby free, Railway about $5/month, LiveKit Cloud free tier, AI per use) and **rollback** (Railway's Rollback on the previous deployment; Vercel's Instant Rollback).

Also: `server/.env.example` documents `NODE_ENV` (production → JSON logs); `README.md` links to `docs/deploy.md`; `docs/architecture.md` updates the deployment row and describes the stop sequence and WebSocket-only connections.

## 7. Testing

`node:test`, the real test Redis (database 1) and Postgres, as in earlier phases.

- **Logger**: JSON mode writes one parseable line with `time`, `level`, `msg`, `base` and fields, `info` to stdout and `warn`/`error` to stderr; text mode prints the same text as today; the default instance follows `NODE_ENV`.
- **Shutdown** (two servers on one Redis):
  - a seated person's server stops: the client's disconnect reason is not `io server disconnect`; the seat carries `graceUntil` in Redis before Redis is closed; the person rejoins on the other server and keeps the seat (no lobby, no "full");
  - an Ask AI answer in progress ends with `ai:failed` for the room;
  - timers are cleared, Redis and Postgres are closed, `shutdown()` resolves to 0;
  - a handler that never finishes can't hold the stop past the 8 s drain; the 10 s watchdog resolves to 1 (use injected short times in the test);
  - a second signal during the stop does nothing.
- **Connections**: the server refuses a long-polling handshake; a WebSocket client connects.
- **Web**: `npm test`, `tsc`, `lint`, `build` (the transport option has no logic to unit-test).
- **Load test**: run in the last task; its numbers fill `LOAD_TEST_RESULTS.md`.

## 8. Files

- New: `server/lib/log.js`, `server/lib/shutdown.js`, `server/scripts/load-check.js`, `server/test/log.test.js`, `server/test/shutdown.test.js`, `docs/deploy.md`, `LOAD_TEST_RESULTS.md`.
- Changed: `server/server.js` (signals, `transports`, logger, start line), `server/lib/room.js` (the in-flight counter and `drain()`, logs, meeting-ended lines), every other `server/` file that logs (`app.js`, `lib/meetings.js`, `lib/webhook.js`, `lib/livekit.js`, `lib/redis.js` and any others found), `server/package.json` (`load-check` script), `server/.env.example`, `web/lib/use-meeting.ts`, `README.md`, `docs/architecture.md`.
