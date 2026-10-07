> **Zylo status (2026-09-15):** this file is the original CoThink planning note, kept for history.
> The build now follows [`superpowers/specs/2026-09-14-zylo-design.md`](superpowers/specs/2026-09-14-zylo-design.md).
> **Phase 1 (sign-in, dashboard, meetings API, pre-join) is complete.** Phase numbering below is the old one.

# CoThink — Build Plan

> **How this differs from `architecture.md`:** that document explains *why* the
> system is shaped this way — read it first if you haven't. This document is the
> *task list*: concrete files, contracts, and checkboxes for actually building each
> phase. If you're an AI coding agent, work top to bottom, one phase at a time, and
> don't start a phase whose checkbox above it isn't checked.

## What this project is

A WebRTC video calling platform where the AI is a **shared participant in the room**
— every person on the call sees the same AI response streaming in at the same time,
not a private assistant panel each. 1:1 calls run peer-to-peer; group calls (up to
10) run through a LiveKit SFU with speaker-view so only active speakers cost video
bandwidth.

**LLM: Grok (xAI).** Everything AI-facing — reactive chat, stuck-detection
judgment, and session summarization — goes through one provider, one key, one
module.

**No speech-to-text.** This was a deliberate cut. See the note in Phase 4 for what
that means for the "proactive AI" feature, because it does change the feature's
honest description.

## Progress

- [ ] **Phase 0** — Migrate the existing AI layer from Claude to Grok
- [x] **Phase 1** — 1:1 call + shared streaming AI chat *(built; uses Claude until Phase 0 runs)*
- [x] **Phase 2** — Group calls (up to 10) via LiveKit + speaker-view
- [ ] **Phase 3** — Save → summarize → delete pipeline
- [ ] **Phase 4** — Proactive stuck-detection (silence + text heuristics, no STT)
- [ ] **Phase 5** — Load test + recorded results
- [ ] **Phase 6** — Auth (Clerk) + room ownership + admin controls + screen sharing
- [ ] **Phase 7** — Concurrency & abuse hardening

Update the checkboxes as you complete each phase. Don't check a box until that
phase's acceptance criteria actually pass — not just "the code looks right."

---

## Phase 0 — Migrate the AI layer from Claude to Grok

### Why this is its own phase

Phases 1–2 were built against Anthropic's API. Grok uses a different request
format, a different auth header, and a **different streaming event shape**. This is
a contained, mechanical change, but do it first and verify it before building
Phase 3 on top — otherwise you'll be debugging two things at once.

### Grok API facts (verified — don't guess these)

- Base URL: `https://api.x.ai/v1`, endpoint `/chat/completions`
- Auth header: `Authorization: Bearer xai-...` (**not** `x-api-key`)
- Get a key at `console.x.ai` → API Keys. The account needs credits loaded.
- The API is **OpenAI-compatible**, so the request/response shape matches OpenAI's
  chat completions, not Anthropic's messages API.
- Current models: **`grok-4.6`** (flagship) and **`grok-4.3`**.
- ⚠️ **Do not use `grok-4`, `grok-3`, `grok-3-mini`, or `grok-4-fast`.** Those slugs
  still resolve, but xAI silently redirects them to `grok-4.3` and bills at
  flagship rates — a surprise-cost trap. Always name a current model explicitly.
- xAI has marked Chat Completions "legacy" in favor of a newer Responses API, but
  it remains fully supported including streaming. Chat Completions is fine here;
  just know the Responses API exists if you revisit this later.

### Tasks

- [ ] **Rename the env var** everywhere: `ANTHROPIC_API_KEY` → `XAI_API_KEY`.
      Update `server/.env.example`, the startup warning in `server.js`, and the
      `ai:error` message text.
- [ ] **Create `server/lib/ai.js`** — pull the inline Claude call out of
      `server.js` and rewrite it for Grok. Two exports, both used by later phases:

```javascript
const XAI_BASE_URL = 'https://api.x.ai/v1';
const MODEL = process.env.XAI_MODEL || 'grok-4.6';

function isConfigured() {
  return Boolean(process.env.XAI_API_KEY);
}

async function callGrok({ system, userText, maxTokens = 1024, stream = false }) {
  return fetch(`${XAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      stream,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userText },
      ],
    }),
  });
}

/** Non-streaming — used by Phase 3 (summaries) and Phase 4 (judgment calls). */
async function ask({ system, userText, maxTokens = 1024 }) {
  const res = await callGrok({ system, userText, maxTokens, stream: false });
  if (!res.ok) throw new Error(`xAI responded ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Streaming — used by Phase 1's reactive shared chat. Returns the full text too. */
async function streamMessage({ system, userText, maxTokens = 1024, onDelta }) {
  const res = await callGrok({ system, userText, maxTokens, stream: true });
  if (!res.ok || !res.body) {
    throw new Error(`xAI responded ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      // Guard: xAI sends heartbeat/terminal chunks with an empty choices array.
      // Indexing [0] blindly here is the #1 way this integration crashes.
      if (!event.choices || event.choices.length === 0) continue;

      const delta = event.choices[0].delta?.content;
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }

  return full;
}

module.exports = { ask, streamMessage, isConfigured, MODEL };
```

- [ ] **Rewire `server.js`'s `ai:message` handler** to
      `require('./lib/ai')` and call `streamMessage({ ..., onDelta: (delta) =>
      io.to(roomId).emit('ai:chunk', { roomId, delta }) })`, then emit `ai:done`.
      Delete the old `streamClaudeResponse` function and the `CLAUDE_MODEL` const.
- [ ] **Keep the system prompt** that's already there (it's provider-agnostic):
      the AI is a shared collaborator in a live call, everyone sees its response at
      once, be concise and concrete.
- [ ] **Add the mediator instruction** to that system prompt — this was specced but
      never written down: *"When participants disagree, don't declare a winner
      unless it's a verifiable fact. Instead, name the specific factor their views
      actually differ on, so the group can resolve it themselves."* Balance is not
      the goal — identifying the real crux is.
- [ ] **Preserve the missing-key behavior.** If `XAI_API_KEY` is unset: warn loudly
      at startup, and emit `ai:error` on `ai:message`. Never fake a reply.

### Acceptance criteria

Two tabs in a 1:1 room. One asks the AI a question. Both tabs see the identical
response stream in token-by-token. Server logs show no crash on the empty-`choices`
heartbeat chunks. With `XAI_API_KEY` unset, the server boots with a warning and the
chat shows a clear error instead of hanging or inventing a response.

---

## Phase 1 (built) — recap

Files: `server/server.js`, `web/lib/useCallRoom.ts`,
`web/app/room/[roomId]/page.tsx`, `web/components/{VideoTile,ChatPanel,CallControls}.tsx`.

Peer-to-peer WebRTC (`getUserMedia` + `RTCPeerConnection`, offer/answer/ICE relayed
over Socket.IO, public STUN) plus the shared streaming AI chat. Per-socket rate
limit of 1 AI request per 3s; input capped at 2,000 chars server-side.

**Socket contract (already implemented — extend, never rename):**

| Event | Payload | Behavior |
|---|---|---|
| `room:join` | `{ roomId, name }` | joins room, broadcasts `room:peer-joined` |
| `webrtc:offer` / `:answer` / `:ice-candidate` | `{ roomId, payload, targetSocketId }` | relayed verbatim (1:1 only) |
| `chat:message` | `{ roomId, sender, text }` | broadcast to everyone in room |
| `ai:message` | `{ roomId, sender, text }` | streams `ai:chunk` `{ delta }` to all, then `ai:done` |
| `ai:rate-limited` | `{ roomId }` | emitted instead of calling the LLM |
| `ai:error` | `{ roomId, message }` | emitted when the provider fails or has no key |

## Phase 2 (built) — recap

Files: `server/server.js` (`GET /livekit-token`), `web/lib/useGroupRoom.ts`,
`web/app/group/[roomId]/page.tsx`, `web/components/VideoGrid.tsx`.

LiveKit group rooms capped at 10 (checked server-side via
`RoomServiceClient.listParticipants` before minting a JWT). Client connects with
`autoSubscribe: false`: **audio always subscribed for everyone**, video subscribed
only for the ~5 most-recently-active speakers, swapped on
`RoomEvent.ActiveSpeakersChanged`. Everyone else renders as an avatar tile.

`GET /livekit-token?roomId&name` → `{ token, url, identity, maxParticipants }`,
`503` if LiveKit env vars unset, `403` if the room is full.

---

## Phase 3 — Save → summarize → delete pipeline

### Goal

A "Save" button that turns the room's chat history into a structured PDF summary,
serves it over a signed time-limited link, and **deletes the raw log the moment the
PDF exists**. Ephemeral by default.

### New files

| File | Responsibility |
|---|---|
| `server/lib/sessionStore.js` | In-memory per-room log with TTL — same interface a Redis version would expose (`append`, `getEntries`, `clear`). |
| `server/lib/pdf.js` | Renders a structured summary object to a PDF buffer via `pdfkit` (pure JS, no Chromium download). |
| `server/lib/signedUrl.js` | HMAC-SHA256 time-limited download tokens — stands in for S3/R2 signed URLs at this scale. |
| `server/storage/` | Generated PDFs. Add to `.gitignore`. |
| `web/components/EphemeralNotice.tsx` | Persistent in-call banner. |

### Tasks

- [ ] `npm install pdfkit` in `/server`.
- [ ] **`lib/sessionStore.js`**: `Map<roomId, { entries, lastActivity }>` where
      `Entry = { sender, text, ts, isAI }`. Export `append(roomId, entry)`,
      `getEntries(roomId)`, `clear(roomId)`. A `setInterval` (call `.unref()` so it
      doesn't block process exit) sweeps every 5 min and drops rooms idle longer
      than `Number(process.env.SESSION_TTL_MS) || 2 * 60 * 60 * 1000`. Expose that
      env var specifically so you can set it to `10000` to test expiry quickly.
- [ ] **Wire into `server.js`**: every broadcast `chat:message` and every completed
      `ai:done` also calls `sessionStore.append(...)`.
- [ ] **`lib/pdf.js`**: `renderSummaryPdf({ roomId, generatedAt, summary }) →
      Promise<Buffer>`. Summary shape:
      `{ keyPoints: string[], decisions: string[], actionItems: string[], ideasExplored: string[] }`.
      Title, room + timestamp subheading, one bulleted section per array
      ("None noted." when empty).
- [ ] **`lib/signedUrl.js`**: `createToken(id, ttlMs = 24h)` and
      `verifyToken(id, token)`. HMAC-SHA256 over `${id}.${expiresAt}` keyed by
      `process.env.SIGNING_SECRET`, compared with `crypto.timingSafeEqual`. Token
      format `${expiresAt}.${hmacHex}`.
- [ ] **`POST /api/sessions/:roomId/save`**:
      1. `getEntries(roomId)`; if empty → `400 { error: 'Nothing to save yet.' }`
      2. Build a transcript string, call `ai.ask(...)` with a system prompt
         demanding **strict JSON matching the summary shape and nothing else** —
         no markdown fences, no preamble
      3. `JSON.parse` in a `try/catch`. On failure → `500` with a clear message.
         **Never fabricate a fallback summary.**
      4. `renderSummaryPdf(...)` → write to `server/storage/${crypto.randomUUID()}.pdf`
      5. `sessionStore.clear(roomId)` — **only after the PDF write succeeds**
      6. → `200 { downloadUrl, summary }`
- [ ] **`GET /download/:id`**: verify `?token=`; `403` if invalid. Else stream the
      PDF with `Content-Type: application/pdf` and a `Content-Disposition`
      attachment filename.
- [ ] **Env**: add `SIGNING_SECRET` and `SESSION_TTL_MS` to `server/.env.example`.
- [ ] **`EphemeralNotice.tsx`**: a small fixed banner rendered for the *entire*
      call in both room pages — not a toast: *"This call isn't recorded. Chat
      history is deleted automatically unless someone saves it."*
- [ ] **Save button** in `CallControls`: POST to the save route, render the returned
      download link on success, show the "nothing to save" case inline rather than
      as a crash.

### Acceptance criteria

Have a short conversation in two tabs. Click Save → a real PDF downloads with
populated sections matching the conversation. Click Save again immediately → you
get "Nothing to save yet," proving the raw log was actually deleted rather than the
button merely disabled. Separately, with `SESSION_TTL_MS=10000`, chat and then wait
15s without saving → the log is gone.

---

## Phase 4 — Proactive stuck-detection (no STT)

### Read this before building

Originally this phase transcribed every participant's audio and ran heuristics over
the words. **Speech-to-text has been cut from the project**, which means:

- ✅ **Still works:** *silence* detection. LiveKit already reports who's speaking
  via `ActiveSpeakersChanged` / `participant.isSpeaking` — no transcription, no
  cost. "Nobody has spoken for 45 seconds" is a real, free signal.
- ✅ **Still works:** text-chat heuristics — stuck phrases and repetition in what
  people *type*.
- ❌ **Does not work:** detecting circular discussion, repetition, or "I don't
  know" in *spoken* conversation. That needs words, and there are none.

**Describe the feature honestly.** It is "the AI notices when the room goes quiet
or when the chat stalls, and offers a nudge" — not "the AI listens to your
conversation." An interviewer will ask how it works, and the honest version is
still a good answer.

### New files

| File | Responsibility |
|---|---|
| `server/lib/stuckDetection.js` | Heuristics + the Grok judgment call + cooldown. |

### Tasks

- [ ] **Client reports voice activity** (cheap, no STT): in `useGroupRoom.ts`, on
      `RoomEvent.ActiveSpeakersChanged`, emit `voice:activity { roomId }` to the
      server (throttle to at most once every ~5s per client so this doesn't spam
      the socket). Server records `lastVoiceActivity.set(roomId, Date.now())`.
      That single timestamp is the entire voice signal — no audio leaves the
      browser.
- [ ] **`lib/stuckDetection.js`** — constants first:
      `SCAN_INTERVAL_MS = 12000`, `SILENCE_THRESHOLD_MS = 45000`,
      `COOLDOWN_MS = 90000`, `MIN_HUMAN_MESSAGES = 2`.
- [ ] `STUCK_PHRASES`: regexes for "i don't know", "idk", "not sure", "stuck",
      "no idea", a repeated "hmm", a lone run of `?`.
- [ ] `jaccardSimilarity(a, b)`: word-set overlap between two strings.
- [ ] `detectHeuristic(roomId, entries, lastVoiceActivity)` — first match wins,
      returns `{ reason, detail }` or `null`:
      1. **voice silence** — `Date.now() - lastVoiceActivity > SILENCE_THRESHOLD_MS`
      2. **chat silence** — same threshold against the last human `Entry.ts`
      3. **stuck phrase** — regex hit on the most recent human entry
      4. **repetition** — last 3 human entries pairwise Jaccard > 0.6
      Return `null` early if there are fewer than `MIN_HUMAN_MESSAGES` human
      entries — don't interject into an empty room.
- [ ] `judgeAndMaybeInterject(roomId, entries, heuristic, io)`: build a window from
      the last ~12 entries, call `ai.ask(...)` with a system prompt explaining that
      the AI is silently observing, which heuristic fired, and that it must reply
      with **either** a short concrete nudge **or** the literal string
      `NO_INTERJECT` if speaking wouldn't help. If the trimmed, lowercased reply
      isn't `no_interject`: append to `sessionStore` with
      `{ isAI: true, isProactive: true, reason }` and
      `io.to(roomId).emit('ai:proactive', entry)`.
- [ ] `startStuckDetectionLoop(io, getActiveRoomIds)`: a `setInterval` (`.unref()`)
      that every `SCAN_INTERVAL_MS` walks active rooms, skips any inside their
      per-room cooldown, and runs detect → judge on the rest.
- [ ] **Wire into `server.js`**: call it once at startup with
      `() => Array.from(rooms.keys())` — reusing the `rooms` Map Phase 1/2 already
      maintains.
- [ ] **Global concurrency cap** on outbound LLM calls from this loop (a simple
      in-flight counter, e.g. max 3 concurrent). Without it, N active rooms all
      firing heuristics at once will hammer xAI's rate limit and fail silently.
- [ ] **Frontend**: handle `isProactive` in `ChatPanel` — show a small caption above
      the bubble naming the trigger, e.g. *"AI noticed: quiet for a while."*
      Making the *why* visible is good interview material.
- [ ] **A snooze control.** A toggle to mute proactive interjections for the room,
      and ideally a sensitivity setting. This is the single biggest trust risk in
      the product: 45 seconds of silence looks identical whether the group is stuck
      or just thinking, and the first bad interruption is the one users remember.

### Acceptance criteria

In a live call, stop talking and stop typing for `SILENCE_THRESHOLD_MS` (lower it
via env to test faster) → the AI interjects with a relevant nudge, visibly tagged
with which heuristic fired. Type "I don't know…" → the stuck-phrase path can fire
instead. Confirm the cooldown blocks back-to-back interjections. Confirm the snooze
toggle fully silences it. Confirm nothing crashes when `XAI_API_KEY` is unset.

---

## Phase 5 — Load test

### Goal

Two genuinely different things need validating, and `lk load-test` only covers the
first: **(1)** can the LiveKit SFU handle the target concurrency, and **(2)** does
*our own* speaker-view subscription code behave correctly with many tiles. The
CLI's synthetic publishers never run our client code, so (1) alone cannot catch a
bug in `useGroupRoom.ts`.

### Cost note

On LiveKit Cloud's free tier (5,000 participant-minutes/month): **100 participants
× 30 minutes = 3,000 participant-minutes = $0.** A full hour is ~$0.50. Do
iterative/dev testing against a self-hosted `livekit-server --dev` (free, unlimited)
and spend the free-tier minutes on one real headline run worth citing.

### Tasks

- [ ] **(1) Raw SFU capacity** — install LiveKit's `lk` CLI (a Go binary, not npm):
```bash
lk load-test \
  --url "$LIVEKIT_URL" \
  --api-key "$LIVEKIT_API_KEY" \
  --api-secret "$LIVEKIT_API_SECRET" \
  --room loadtest-room \
  --video-publishers 10 \
  --subscribers 10 \
  --duration 2m
```
      Record the printed report (bitrate, latency, dropped packets).
- [ ] **(2) Application-level correctness** — open ~10 real instances of *our app*
      using Chrome's fake media devices, all joined to one group room:
```bash
open -na "Google Chrome" --args \
  --use-fake-device-for-media-stream \
  --use-fake-ui-for-media-stream \
  --user-data-dir=/tmp/cothink-fake-1 \
  http://localhost:3000
```
      Repeat with a different `--user-data-dir` per simulated participant. Confirm:
      everyone gets a tile; only ~5 have live video; closing a window that had live
      video promotes someone else into the visible set; the shared AI chat still
      streams identically everywhere.
- [ ] **Record results** in `LOAD_TEST_RESULTS.md` at the repo root: date,
      machine/network specs, the `lk` report table, and written notes from (2) —
      **including anything that broke.** An honest "here's what didn't hold up" is
      more credible than a flawless-looking report.

### Acceptance criteria

Both runs complete without the server crashing or the SFU dropping the room, and
`LOAD_TEST_RESULTS.md` contains real measured numbers — not placeholders. These are
the numbers you cite instead of an unverified "scales to 100."

---

## Phase 6 — Auth (Clerk) + room ownership + admin controls + screen sharing

### Why Clerk rather than hand-rolled JWT

Clerk handles signup/login UI, password hashing, session tokens, refresh rotation,
and MFA. Building that from scratch is a week of work and a large security surface.
Free tier covers far more monthly active users than a portfolio project will see.
The skill being demonstrated is *integrating an auth provider correctly and
enforcing authorization server-side* — which is what real production work is.

### New files

| File | Responsibility |
|---|---|
| `server/lib/db.js` | Postgres pool + query helpers. |
| `server/db/migrations/001-init.sql` | `users`, `rooms`, `room_members`. |
| `server/db/migrate.js` | Runs migrations on boot. |
| `server/middleware/auth.js` | Verifies Clerk tokens for Socket.IO and Express. |
| `server/lib/roomPerms.js` | Role/permission lookups. |
| `web/components/AdminPanel.tsx` | Kick / mute / toggle screen-share. |

### Tasks

- [ ] Create a Clerk application; put `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in
      `web/.env.local` and `CLERK_SECRET_KEY` in `server/.env`.
- [ ] `npm install @clerk/nextjs` (web) and `@clerk/clerk-sdk-node pg` (server).
- [ ] **Schema** (`001-init.sql`):

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,               -- Clerk user ID
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),   -- permanent owner
  current_admin TEXT REFERENCES users(id),         -- who holds powers right now
  created_at TIMESTAMP DEFAULT NOW(),
  max_participants INT DEFAULT 10,
  current_count INT DEFAULT 0,                     -- used by Phase 7's atomic cap
  name TEXT
);

CREATE TABLE room_members (
  id SERIAL PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','moderator','participant')),
  joined_at TIMESTAMP DEFAULT NOW(),
  can_screen_share BOOLEAN DEFAULT TRUE,
  UNIQUE(room_id, user_id)
);

CREATE INDEX idx_room_members_room ON room_members(room_id);
CREATE INDEX idx_room_members_user ON room_members(user_id);
```

- [ ] **`middleware/auth.js`**: `verifyToken` from `@clerk/clerk-sdk-node` against
      `CLERK_SECRET_KEY`. A Socket.IO middleware reading
      `socket.handshake.auth.token` and attaching `socket.userId` / `socket.userEmail`;
      an Express middleware reading the `Authorization: Bearer` header and attaching
      `req.userId`. Apply the Socket.IO one with `io.use(...)`.
- [ ] **Client sends the token**: in both hooks, `const { getToken } = useAuth()`,
      then `io(SIGNALING_URL, { auth: { token: await getToken() } })`.
- [ ] **`POST /api/rooms`** (authed): insert into `rooms` with
      `created_by = req.userId` and `current_admin = req.userId`, plus a
      `room_members` row with role `admin`. Return `{ roomId }`.
- [ ] **On `room:join`**: upsert a `room_members` row with role `participant`
      (`ON CONFLICT DO NOTHING` — never silently demote an existing admin).
- [ ] **`lib/roomPerms.js`**: `getUserRoleInRoom`, `isAdmin`, `canScreenShare`.
- [ ] **Screen sharing, client side**: `getDisplayMedia({ video: { cursor: 'always' } })`,
      then publish to LiveKit with `source: Track.Source.ScreenShare`. Emit
      `screen:start` first and only publish once the server confirms. Wire
      `screenTrack.onended` to emit `screen:stop`.
- [ ] **Screen sharing, server side**: on `screen:start`, check `canScreenShare`
      → reject with `screen:error` if not permitted; otherwise broadcast
      `screen:started`. (The one-at-a-time lock is Phase 7.)
- [ ] **Admin routes** (each gated by `isAdmin`):
      `POST /api/rooms/:roomId/kick { userId }` → delete the membership row,
      broadcast `room:participant-removed`.
      `POST /api/rooms/:roomId/toggle-screen-share { userId, allowed }` → update
      the column, broadcast `room:permissions-changed`.
- [ ] **`AdminPanel.tsx`**: renders only when the current user is admin; lists
      participants with kick / mute / block-screen buttons wired to those routes.
- [ ] **Protect the room pages**: redirect unauthenticated users home; show Clerk's
      `<SignIn />` on the home page when signed out.

### Acceptance criteria

Sign up → create a room → confirm you're `admin` in the DB. Second user joins →
confirm `participant`. Admin blocks their screen share → confirm they cannot start
one and get a clear error. Admin kicks them → confirm removal + broadcast event.
Sign out and back in → identity persists. Confirm a non-admin calling the admin
routes directly (curl, with their own valid token) gets `403` — authorization must
be enforced server-side, not just by hiding UI buttons.

---

## Phase 7 — Concurrency & abuse hardening

### Goal

Fix the four real failure modes that only show up under contention or attack. Each
is small; together they're the difference between a demo and something you'd
defend in a system-design interview.

### Tasks

#### 7a — The join race (two people, one slot)

- [ ] **The bug**: `/livekit-token` currently `await`s `listParticipants()` and
      *then* checks the count. That `await` yields the event loop, so two requests
      can both observe "9 of 10" and both get a token → 11 people in a 10-person room.
      This is a textbook TOCTOU (time-of-check-to-time-of-use) race.
- [ ] **Single-process fix**: an in-memory reservation counter where the check and
      the increment happen with **no `await` between them**:

```javascript
const roomReservations = new Map(); // roomId -> count

function tryReserveSlot(roomId, max) {
  const current = roomReservations.get(roomId) || 0;
  if (current >= max) return false;
  roomReservations.set(roomId, current + 1); // no await between read and write
  return true;
}
```
      Node runs one handler at a time per tick, so with no yield point between the
      read and the write, two concurrent requests cannot interleave here.
- [ ] **Handle reservation leaks**: someone can take a token and never connect
      (closed tab, dead network), holding a slot forever. Give reservations a ~30s
      expiry, confirm them permanently on LiveKit's `participant_joined` webhook,
      and sweep expired-unconfirmed ones on an interval.
- [ ] **Know the boundary, and say so**: this counter is per-process. The moment you
      run two server instances it's wrong again. The multi-instance fix is to let
      Postgres do it atomically:
```sql
UPDATE rooms SET current_count = current_count + 1
WHERE id = $1 AND current_count < max_participants
RETURNING *;
```
      Zero rows returned = room full. Postgres guarantees atomicity across
      processes. Implement this if/when you scale out.

#### 7b — Screen-share contention

- [ ] **One active screen share per room**, admin-overridable. This is both a
      bandwidth issue (screen shares are higher-resolution than camera feeds, and N
      simultaneous ones wreck the SFU budget) and the universal UX convention.
```javascript
const activeScreenShare = new Map(); // roomId -> userId | null
```
- [ ] **Handle the sharer vanishing**: if they disconnect without emitting
      `screen:stop` (closed laptop, crashed tab), the `disconnect` handler must clear
      the lock — otherwise the slot is stuck forever and nobody else can present.
- [ ] **Add `screen:force-stop`** for admins, so a presenter can be cut off without
      waiting for them to notice.

#### 7c — Admin succession

- [ ] **Separate permanent ownership from live powers**: `rooms.created_by` never
      changes (displayed as "room owner"); `rooms.current_admin` is who holds powers
      right now.
- [ ] **On admin disconnect**, auto-promote the longest-present connected member
      (`MIN(joined_at)` among those still in the room). Deterministic and easy to
      explain. **Never leave a room with zero admins** — a room nobody can moderate
      is a room where a disruptive participant can't be removed.
- [ ] **On owner rejoin**, they reclaim `current_admin` immediately.
- [ ] **Don't fully demote the stand-in** — promote them to `moderator` rather than
      back to `participant`. Small touch, but it's the right product instinct.
- [ ] Broadcast `room:admin-changed` so every client's UI updates live.

#### 7d — Brute-forcing room codes

- [ ] **Escalating backoff, not a flat ban.** A fixed "10 min then a month" is
      simultaneously too harsh (one bad actor on an office/campus NAT blocks the
      whole building) and too weak (a real attacker rotates IPs or waits it out).
```javascript
const BACKOFF_SCHEDULE_MS = [
  60_000,                 // 1st violation: 1 min
  10 * 60_000,            // 2nd: 10 min
  60 * 60_000,            // 3rd: 1 hour
  24 * 60 * 60_000,       // 4th: 1 day
  30 * 24 * 60 * 60_000,  // 5th+: 30 days (cap — never truly permanent)
];
```
- [ ] **Decay the violation count** after a long quiet period, so someone who
      mistyped a code last month isn't still flagged.
- [ ] **Key on authenticated user ID too, not just IP.** Post-Phase 6 you have real
      identities; an IP is a weak signal that a stranger may share with hundreds of
      people behind a NAT.
- [ ] **CAPTCHA before hard-blocking** — the standard middle ground that keeps
      fat-fingering humans unblocked while stopping scripts.
- [ ] **Rate-limit `/livekit-token`** — the AI chat path is limited but this REST
      endpoint isn't, which makes it trivially spammable.
- [ ] **The real fix is architectural, and worth stating**: a room code alone is a
      weak security boundary. The strong version is an admin-controlled invite list
      of specific user IDs, where knowing the code isn't sufficient. That changes
      the threat model instead of just slowing the attack down.

#### 7e — Other hardening worth doing

- [ ] **Idempotency on save**: if the client times out after the server already
      saved and deleted, a retry returns "nothing to save" and the user thinks their
      data vanished. Accept a client-generated request ID and return the existing
      result on a repeat.
- [ ] **Cancel in-flight LLM calls when a room empties** — use an `AbortController`
      tied to room-empty, or you're paying for tokens nobody will read.
- [ ] **Schema-validate socket payloads** (`zod` or similar). Length capping isn't
      type checking.
- [ ] **Graceful shutdown** on `SIGTERM` — drain in-flight streams instead of
      killing them mid-deploy.
- [ ] **Message history replay on join** — keep the last ~50 messages per room and
      send them on `room:join`, so a refresh or a late join doesn't show an empty
      chat.
- [ ] **Reconnection logic for the 1:1 path** — currently a two-second network blip
      permanently kills the call until a manual refresh.
- [ ] **Structured logging with room/user correlation IDs** — grepping raw console
      output stops working the moment you have real traffic.

### Acceptance criteria

Script two simultaneous token requests against a room with one slot free → exactly
one succeeds. Two users try to share screen at once → the second gets a clear
"someone is already sharing." Admin closes their tab → another member is promoted
within seconds and the UI reflects it; the owner rejoining reclaims it. Hammer a
bad room code repeatedly → timeouts escalate rather than jumping straight to a ban.

---

## Operating rules for every phase

- **Verify external APIs before coding against them.** Phases 1–2 were built by
  checking the installed SDK's real surface (`npm view`, reading the shipped
  `.d.ts` files) rather than trusting memory. Do the same for Clerk, `pdfkit`, and
  anything else — versions move.
- **Never fabricate a response when credentials are missing.** No key → a loud
  startup warning and a clear error to the client. Never a mocked "success."
- **Don't build ahead of the phase you're on.** Each phase must be independently
  verifiable before the next begins.
- **Enforce authorization server-side.** Hiding a button is not a permission check.
- **Match the existing design tokens** in `web/app/globals.css` — keep the AI's
  violet identity visually distinct from human messages. No generic SaaS-card look.
- **When you finish a phase**: tick its box above, and update `architecture.md` the
  same way Phase 2 did. The docs should describe what is *actually true of the
  repo*, not what was originally hoped for.
