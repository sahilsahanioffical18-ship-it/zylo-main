# Zylo — Implementation Plan (login-first, host-controlled meetings)

## Context

The user wants **Zylo** (formerly "CoThink" in the design notes) to work like a real, professional
meeting product: **sign in → dashboard (previous / upcoming / instant meetings) → video meeting**.
`~/Downloads/architecture.md` and `~/Downloads/plan.md` are design notes only; nothing is built yet.
This plan starts a fresh repo in `~/Documents/Claude_WebRtc` (currently empty).

Decisions from review (2026-09-14):
- **Every meeting runs on LiveKit**, up to **20 people**.
- **Only the host** (whoever created the meeting) has any control.
- **Admission** is set by the host to **auto or manual**, and stays race-safe when one seat is left.
- **One screen share at a time**, enforced on the server.
- **PDF feature removed.**
- **AI chat and stuck-detection come last.**
- **Frontend designed with the ui-ux-pro-max plugin**, including its palette.
- **Product name Zylo**, with named activities (below).

Reference only: `~/Desktop/cothink-mvp/web/lib/useGroupRoom.ts` has working LiveKit speaker-view
subscription logic to port. It is not the base repo.

## Product naming

| Name | Activity | Where it appears |
|---|---|---|
| **Zylo** | The product | Logo, page titles, landing, Clerk app name, emails from Clerk |
| **ZyloMeet** | Scheduled meetings | Dashboard "ZyloMeet · Schedule" button + Schedule dialog; "ZyloMeet" section with Upcoming \| Previous tabs |
| **ZyloCall** | Instant meeting you start right now | Dashboard primary "ZyloCall · Start now" button |
| **ZyloRoom** | The in-meeting room: video stage, controls, lobby, host controls | Room top bar, pre-join ("Join ZyloRoom"), waiting card |
| **ZyloLive** | Screen sharing / presenting | Control bar "ZyloLive" share button; stage banner "ZyloLive · Priya is presenting"; toasts ("ZyloLive is in use by Priya") |
| **ZyloChat** | In-meeting chat (human; AI joins it in Phase 8) | Control bar "ZyloChat" button and side-panel tab |

Brand names are **UI copy only**, kept in one `web/lib/brand.ts` constant so a future rename is a
one-file change. Code identifiers, socket events and routes stay technical (`screen:*`,
`chat:message`, `/m/:code`).

## Stack (versions checked with `npm view` on 2026-09-14)

| Layer | Choice |
|---|---|
| Web | Next.js 16 (App Router, TS), React 19, **Tailwind CSS v4 + shadcn/ui (CLI 4)**, Lucide icons, `next/font` (Plus Jakarta Sans) |
| Auth | Clerk: `@clerk/nextjs` 7 (web); `@clerk/express` 2 + `@clerk/backend` 3 (server). Not `@clerk/clerk-sdk-node` (support ended Jan 2025) |
| Server | Node 22, Express + Socket.IO 4.8, CommonJS, runs with `node server.js` |
| DB | Postgres 16 via `docker compose`, `pg` 8 |
| Media | LiveKit: `livekit-client` 2.22 + `@livekit/components-react` hooks/primitives (web, unstyled); `livekit-server-sdk` 2.19 (server). Dev: local `livekit-server --dev` (`brew install livekit`) |
| AI (last phase) | Grok (xAI), server-side only |

### LiveKit free tier vs 15–20 people (checked on livekit.com/pricing, 2026-09-14)

**Build plan (free):** 5,000 WebRTC participant-minutes/month, 100 concurrent connections, 50 GB
downstream data, no card needed.
**Ship plan:** $50/mo, 150,000 minutes, 1,000 concurrent.

- **Concurrency:** 20 people is well under 100.
- **Minutes:** one 1-hour, 20-person meeting uses 1,200 minutes, so about **4 such meetings a month**.
- **Data:** a rough estimate, to be measured in Phase 7. About 10–14 GB per 20-person hour with
  speaker view, so about 3–5 such meetings a month.

**Conclusion:** develop and load-test on local `livekit-server --dev` (free, no limits) and use the
free Cloud tier only for demos. Connect with `adaptiveStream: true, dynacast: true`, and subscribe
to live video for only the 5 most-recent speakers plus any ZyloLive share. Everyone else shows as an
avatar, with audio always on.

## Frontend design system (ui-ux-pro-max)

**Source.** Generated with:
`search.py "video conferencing collaboration SaaS professional" --design-system -p "Zylo" --variance 4 --motion 3 --density 6`

- Supplemented by `--domain color`, `--domain typography`, `--domain ux` and `--stack shadcn` searches.
- In Phase 1 it gets persisted with `--persist --output-dir ~/Documents/Claude_WebRtc` to
  `design-system/zylo/MASTER.md`, plus page overrides `pages/dashboard.md` and `pages/meeting-room.md`.
- Every UI task reads MASTER plus its page override first, as the plugin's workflow requires.

**Style: Soft UI Evolution.** The plugin's pick for SaaS and business tools.
- Soft, clear shadows and subtle depth.
- 200–300 ms transitions, always-visible focus rings, 4.5:1 text contrast.
- Avoid a cluttered interface, emoji used as icons, and the generic gradient SaaS look.
- Motion dial 3 (subtle): CSS/Tailwind transitions only, no GSAP, and `prefers-reduced-motion` respected.

**Light palette** (landing, auth, dashboard): plugin palette *"Remote Work/Collaboration Tool — calm indigo + success green"*:

| Token (shadcn var) | Hex | On-color |
|---|---|---|
| `--primary` | `#6366F1` | `#000000` |
| `--secondary` | `#818CF8` | `#0F172A` |
| `--accent` (success / Live) | `#059669` | `#000000` |
| `--background` | `#F5F3FF` | — |
| `--foreground` | `#312E81` | — |
| `--card` | `#FFFFFF` | `#312E81` |
| `--muted` | `#EBEFF9` | `#475569` |
| `--border` | `#E0E7FF` | — |
| `--destructive` (Leave / End / Kick) | `#DC2626` | `#FFFFFF` |
| `--ring` | `#6366F1` | — |

> **Implemented deviation (Phase 1):** shadcn's `--accent` is the hover/selected surface (`#e0e7ff` light, primary tint dark); the design system's green CTA and amber are exposed as `--success` and `--warning` tokens instead. See `web/app/globals.css`.

**Dark palette** (ZyloRoom, which is always dark like Meet/Zoom, and the dashboard's dark mode):
plugin dark palette with the **same indigo + green pair** on slate. It's filed under the plugin's
"Fasting timer" product, but was chosen only because its brand colors match exactly.

| Token | Hex |
|---|---|
| `--background` | `#0F172A` |
| `--foreground` | `#FFFFFF` |
| `--card` | `#192134` |
| `--muted` / `--muted-foreground` | `#151D39` / `#94A3B8` |
| `--border` | `rgba(255,255,255,0.08)` |
| `--primary` / on | `#6366F1` / `#000000` |
| `--secondary` / on | `#4338CA` / `#FFFFFF` |
| `--accent` / on | `#059669` / `#000000` |
| `--destructive` / on | `#DC2626` / `#FFFFFF` |
| `--ring` | `#6366F1` |

**Status colors.** The plugin pattern calls for green/amber/red.
- **Live / Admitted / speaking ring / ZyloLive banner:** `--accent` `#059669`.
- **Waiting / lobby / Scheduled-soon:** amber `#D97706` with `#000000` text (amber taken from the plugin's color data).
- **Error / Leave / End:** `--destructive`.
- **AI in ZyloChat (Phase 8):** the `--secondary` indigo tint, so AI bubbles stay visibly different from human messages.

**Typography.** Plus Jakarta Sans only; the plugin's "Friendly SaaS" pairing.
- Loaded with `next/font/google`.
- Weights: 800 page titles, 700 section headers, 600 card titles and buttons, 400 body.
- Base size 16px, line-height 1.5.
- `tabular-nums` for timers and seat counts.

**Components (shadcn, customized, never used as-is).**
- **Scaffolding:** the `dashboard-01` block is the starting point for the dashboard shell.
- **Primitives:** `Button`, `Card`, `Dialog`, `AlertDialog` (End for all, Kick), `Input`, `Label`,
  `Field`, `RadioGroup` (admission, share policy), `Calendar` + `Popover` (schedule date),
  `Select` (time), `Tabs` (Upcoming / Previous), `Badge` (Live, Host, Manual, x/20), `Avatar`,
  `DropdownMenu` (participant actions), `Sheet` (ZyloChat / People on mobile), `Tooltip` (every
  icon-only button, plus `aria-label`), `ScrollArea`, `Skeleton`, `Sonner` toasts.
- **Forms:** the ZyloMeet schedule form uses controlled state plus shadcn `Field` primitives; no form
  library.
- **Clerk:** themed through `appearance.variables` (`colorPrimary #6366F1`, font, radius), and the
  Clerk app is named "Zylo".
- **LiveKit:** use `@livekit/components-react` primitives (`VideoTrack`, `RoomAudioRenderer`,
  `useTracks`) inside our own shadcn-styled tiles. Don't import `@livekit/components-styles`.

**Page layouts**
- **Landing `/`:**
  - Top nav: Zylo logo, Sign in, primary "Get started".
  - Hero: headline, one-line value, CTA, and a static ZyloRoom product screenshot. No fake "live" data.
  - Four feature cards: **ZyloCall** (start instantly), **ZyloMeet** (schedule and invite),
    **ZyloRoom** (host-controlled, up to 20), **ZyloLive** (one presenter at a time). Then a footer.
- **Sign in / Sign up:** split layout. Zylo brand panel on the left, themed Clerk form on the right;
  the brand panel is hidden on mobile.
- **Dashboard** (sidebar shell from `dashboard-01`, `UserButton` in the header):
  - Greeting and date.
  - Action row: **ZyloCall · Start now** (primary), **ZyloMeet · Schedule** (opens the dialog),
    **Join with code** (input + button).
  - "Live now" strip, shown only when a meeting is live.
  - **ZyloMeet** section with `Tabs` for Upcoming and Previous. Each row shows title, time or duration,
    avatar stack, badges, and a `DropdownMenu` with Join, Copy link, and Cancel (host only).
  - Skeletons while loading. Empty states with an icon and a call to action.
- **Pre-join** `/m/:code`, two columns:
  - Left: 16:9 camera preview with mic and camera toggles.
  - Right: meeting title, host, admission badge, signed-in identity, and a large **Join ZyloRoom**
    button. Camera or mic denied → an inline alert explaining how to allow access.
- **Waiting:** a centered card with spinner and message: "Waiting for the host to let you into this
  ZyloRoom", "Host hasn't joined yet", or "ZyloRoom is full — you're #N in line". Plus a Leave button.
- **ZyloRoom** (dark):
  - **Top bar:** title, elapsed timer, seat badge `12/20`, admission badge (host only).
  - **Stage:** auto-fit 16:9 tile grid with a green speaking ring and a muted icon. During a
    **ZyloLive** share, the shared screen fills the stage with a banner "ZyloLive · Priya is
    presenting", and the tiles move to a filmstrip.
  - **Bottom control bar** (44px+ targets with tooltips): Mic, Camera, **ZyloLive** (share), **ZyloChat**,
    People (count badge, plus a lobby badge for the host), Leave (red). The host also gets **End for all**.
  - **Right panel** (docked on ≥1024px, a `Sheet` below that): **ZyloChat**, and People. For the host,
    People also has the lobby with Admit / Deny, the admission and ZyloLive-policy settings, and each
    person's ⋯ menu with Mute, Stop ZyloLive, Kick.
- **Breakpoints:** 375 / 768 / 1024 / 1440. No horizontal scroll.

## User flow

```
/                 signed out: Zylo landing + Sign in / Sign up (Clerk)     signed in: → /dashboard
/dashboard        (protected)
  ├─ [ZyloCall · Start now]  admission=auto, ZyloLive=anyone (host can change in-room) → /m/:code
  ├─ [ZyloMeet · Schedule]   Dialog: title, date+time, admission auto|manual, ZyloLive host-only|anyone, invite emails
  ├─ [Join with code] → /m/:code
  ├─ Live now: meetings in progress I host / I'm invited to / I'm in
  └─ ZyloMeet: Upcoming (scheduled ≥ now−1h, not ended) | Previous (I was admitted, ended — latest 50)
/m/:code          (protected)
  ├─ not found / cancelled / removed → message + back to dashboard
  ├─ Pre-join → [Join ZyloRoom]
  ├─ Waiting (manual lobby, or auto queue when full)
  └─ ZyloRoom (host additionally gets lobby + host controls)
```

## Authentication

- **Web:** `proxy.ts` (Next 16's name for middleware) uses `clerkMiddleware`, protecting
  `/dashboard(.*)` and `/m(.*)`. Signed-out users are redirected to sign-in.
- **REST:** `clerkMiddleware()` runs on every request, and `requireUser` checks `getAuth(req).userId`.
  With no user it returns JSON `401`; don't use `requireAuth()`, which redirects.
- **Socket.IO:** `io.use` → `verifyToken(handshake.auth.token, { secretKey, authorizedParties: [CLIENT_ORIGIN] })`.
  The client passes `auth` as a callback so every reconnect fetches a fresh short-lived token.
- **User records:** `ensureUser` upserts `users` from `clerkClient.users.getUser` the first time a
  user is seen by this process.
- **Identity** (userId, name) always comes from the verified token plus `users`. Nothing
  identity-related is read from client payloads.
- **LiveKit tokens:**
  - Minted only for a user who currently holds a seat.
  - `identity = userId`, `ttl = 10m`.
  - Grants: `roomJoin`, `canSubscribe`, `canPublish`, `canPublishSources: [CAMERA, MICROPHONE]`.
  - Clients never get `roomAdmin`. Host actions go through our server, which calls `RoomServiceClient`.

## Authorization (enforced on the server; hiding UI is not a check)

| Action | Host | Admitted participant | Waiting / other signed-in user |
|---|---|---|---|
| Start a ZyloCall / schedule a ZyloMeet (you become its host) | ✓ | ✓ | ✓ |
| Cancel a scheduled ZyloMeet that hasn't started | ✓ | ✗ | ✗ |
| Open `/m/:code`, request to join | ✓ (always gets the reserved host seat) | — | ✓ (unless removed) |
| Get a LiveKit token, see/hear the ZyloRoom, use ZyloChat | ✓ | ✓ | ✗ |
| Own camera / mic on/off | ✓ | ✓ | — |
| Start ZyloLive (screen share) | ✓ (if nobody is sharing) | only if policy = `anyone` and nobody is sharing | ✗ |
| Admit / deny from lobby | ✓ | ✗ | ✗ |
| Change admission mode or ZyloLive policy | ✓ | ✗ | ✗ |
| Kick (removed for the rest of this meeting) | ✓ | ✗ | ✗ |
| Mute someone's mic | ✓ | ✗ | ✗ |
| Stop someone else's ZyloLive | ✓ | ✗ | ✗ |
| End meeting for everyone | ✓ | ✗ | ✗ |

- **Host check:** every `host:*` handler compares `meetings.host_id` (from the DB, cached per live
  meeting) with `socket.data.userId`. On mismatch it emits `error:forbidden` and does nothing.
- **Host absent:** nobody gets powers and the meeting continues. The manual lobby waits; auto mode
  keeps admitting. When the host rejoins they get their reserved seat and all powers back.

## Seats, admission and the "one seat left" race

**State:** in memory in `server/lib/seats.js`, pure logic with no I/O and unit tested. For each live
meeting it holds `{ seats: Map<userId, {socketId, name, graceTimer}>, queue: userId[], sharer: userId | null }`.

**Seat count:**
- `max_participants` defaults to 20 (range 2–20) and includes the host.
- **The host's seat is always reserved**, so others can take at most `max − 1` seats.

**Atomic seat grab:**
- `tryTakeSeat` reads the count and writes the seat in one synchronous block with **no `await`
  between check and set**. Node runs one handler step at a time, so two requests that arrive
  together can't both see "1 seat left"; the first to reach the server wins.
- DB lookups (meeting exists, user not removed) run before this block, never inside it.
- `ponytail:` single process only. With more than one server instance (Phase 7), move to Redis with
  an atomic Lua script.

**Auto mode:**
- A seat is free → `meeting:admitted`.
- The room is full → the user joins a **FIFO queue** and gets `meeting:waiting { position }`. The
  queue head is admitted automatically when a seat frees, and everyone else gets their new position.
- *Example: 19 of 20 seats taken, 2 people press Join together → the first to arrive is admitted,
  the second is #1 in line and gets in when anyone leaves.*

**Manual mode:**
- Every joiner waits in the lobby. The host gets `lobby:update`.
- `lobby:admit` runs the same atomic `tryTakeSeat`; if the room is full the host sees "ZyloRoom is full".
- `lobby:deny` → `meeting:denied { reason: 'denied' }`.

**Mode switch:** manual → auto admits people from the lobby in order until seats run out; the rest
become the auto queue.

**Leaving:**
- On disconnect the seat is held for a **30 s grace period**. The same user reconnecting within it
  gets the seat back. Otherwise it's released and the queue advances.
- An explicit Leave releases the seat immediately.

**Two tabs, same user:** one seat per userId. The new socket takes over and the old one gets `meeting:replaced`.

**Second cap at LiveKit:** `createRoom({ name, maxParticipants, emptyTimeout: 300 })` runs before
the first token is minted.

**Removed users:** kick sets `meeting_participants.removed_at`. Join requests and token minting check
it, and this survives a server restart.

## ZyloLive — screen share (one at a time)

1. **Request.** The client emits `screen:request`. The server checks the policy (host always allowed),
   then the synchronous `tryTakeScreenLock` (if `sharer` is empty, set it, no `await` between).
2. **Two people press ZyloLive together.** The first request to arrive wins. The second gets
   `screen:denied { reason: 'busy', sharerName }`, shown as a toast: "ZyloLive is in use by Priya".
3. **Grant.** `updateParticipant(room, userId, { permission: { canPublishSources: [CAMERA, MICROPHONE, SCREEN_SHARE, SCREEN_SHARE_AUDIO], canPublish: true, canSubscribe: true } })`,
   then emit `screen:granted`. Only then does the client call `getDisplayMedia` and publish.
   Everyone gets `screen:state { sharerUserId }`.
4. **Release.** The lock clears when any of these happen: the sharer stops, `track.onended` fires
   (the browser's "Stop sharing"), the host stops it, or the sharer's seat is released. Then:
   - The server revokes the screen source permission.
   - It tells the client to unpublish.
   - It broadcasts `screen:state { sharerUserId: null }`.
   Whether revoking one source unpublishes the track isn't documented, so Phase 4 tests it. If it
   doesn't, briefly revoke `canPublish`, then restore camera and mic.

## Data model — `server/db/schema.sql` (run on every boot; idempotent)

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                 -- Clerk user id
  email TEXT UNIQUE NOT NULL,          -- lowercased
  name TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,                 -- 'abc-defg-hij'; also the LiveKit room name
  host_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  admission TEXT NOT NULL DEFAULT 'auto' CHECK (admission IN ('auto','manual')),
  screen_share_policy TEXT NOT NULL DEFAULT 'anyone' CHECK (screen_share_policy IN ('host_only','anyone')),
  max_participants INT NOT NULL DEFAULT 20 CHECK (max_participants BETWEEN 2 AND 20),
  scheduled_for TIMESTAMPTZ,           -- NULL = ZyloCall (instant); set = ZyloMeet (scheduled)
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meeting_invites (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (meeting_id, email)
);
CREATE TABLE IF NOT EXISTS meeting_participants (   -- a row = was admitted at least once
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('host','participant')),
  first_joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,              -- set by kick; blocks rejoin
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS meetings_host_idx ON meetings (host_id);
CREATE INDEX IF NOT EXISTS invites_email_idx ON meeting_invites (email);
CREATE INDEX IF NOT EXISTS participants_user_idx ON meeting_participants (user_id);
```
**Lifecycle:**
- First admission: `started_at = COALESCE(started_at, now())`, `ended_at = NULL`.
- Last seat released, or the host ends the meeting: `ended_at = now()`.
- On boot: close meetings left open by a crash.

`ponytail:` a single idempotent schema file. Switch to numbered migrations the first time a change
can't be written with `IF NOT EXISTS`.

## Contracts

**REST** (all need auth except `/health`; invalid input returns `400 { error }`):

| Route | Input | Output |
|---|---|---|
| `GET /health` | — | `{ ok, db, livekit }` |
| `GET /api/dashboard` | — | `{ live: MeetingCard[], upcoming: MeetingCard[], previous: MeetingCard[] }` |
| `POST /api/meetings` | `{ title?, scheduledFor?, admission?, screenSharePolicy?, maxParticipants?, inviteEmails? }` | `201 { meeting }` |
| `GET /api/meetings/:id` | — | `{ meeting, isHost }` · `404` |
| `DELETE /api/meetings/:id` | — | `204` · `403` not host · `409` already started |
| `GET /api/meetings/:id/livekit-token` | — | `{ token, url }` · `403` no seat or removed · `503` LiveKit env missing |

**Validation (hand-written):**
- `title`: max 120 characters; defaults to "ZyloCall" when instant; required when scheduled.
- `scheduledFor`: future, within 1 year.
- `admission` and `screenSharePolicy`: must be one of their allowed values.
- `maxParticipants`: 2–20.
- `inviteEmails`: max 20, lowercased, de-duplicated.
- `:id`: must match the code format.

The meeting code comes from `crypto.randomInt`. On a primary-key clash, retry once.

**Socket.IO:**

| Direction | Event | Payload / behavior |
|---|---|---|
| C→S | `meeting:join-request` | `{ meetingId }` → `meeting:admitted` · `meeting:waiting { position, manual }` · `meeting:denied { reason: 'not_found'|'ended'|'removed'|'denied' }` |
| S→C | `room:presence` | `{ people: [{ userId, name, imageUrl, isHost }] }` to seated members |
| S→host | `lobby:update` | `{ waiting: [{ userId, name, imageUrl }] }` |
| host→S | `lobby:admit` / `lobby:deny` | `{ userId }` |
| host→S | `host:set-admission` / `host:set-screen-policy` | `{ mode }` / `{ policy }` → broadcast `meeting:settings` |
| host→S | `host:kick` | `{ userId }` → `removed_at`, release seat, `removeParticipant`, target gets `meeting:removed` |
| host→S | `host:mute` | `{ userId }` → `mutePublishedTrack` on their mic (they can unmute themselves; check in Phase 4) |
| host→S | `host:stop-share` / `host:end-meeting` | release ZyloLive lock / `deleteRoom`, `ended_at`, everyone gets `meeting:ended` |
| C→S | `screen:request` / `screen:stop` | ZyloLive → `screen:granted` · `screen:denied` · broadcast `screen:state` |
| C↔S | `chat:message` | ZyloChat: `{ text }` (max 2,000 chars) → broadcast `{ userId, name, text, ts }` to seated members only |
| S→C | `meeting:replaced`, `error:forbidden` | — |

## Repo layout (`~/Documents/Claude_WebRtc`)

```
docker-compose.yml              postgres:16
package.json                    name "zylo"; scripts: db:up, livekit (livekit-server --dev), dev, dev:server, dev:web
design-system/zylo/             MASTER.md + pages/dashboard.md, pages/meeting-room.md (ui-ux-pro-max)
docs/                           architecture.md + plan.md from ~/Downloads, rewritten for Zylo and this plan
server/
  server.js                     express + socket.io bootstrap, schema + stale sweep on boot
  lib/db.js                     pg Pool + query()
  lib/auth.js                   requireUser, socketAuth, ensureUser
  lib/meetings.js               code gen, validation, SQL, REST router (incl. livekit-token)
  lib/seats.js                  pure in-memory seats / queue / ZyloLive lock
  lib/room.js                   socket handlers: join, lobby, host:*, screen:*, chat, lifecycle
  lib/livekit.js                token minting + RoomServiceClient helpers
  db/schema.sql
  test/seats.test.js            node:test — last-seat race, reserved host seat, FIFO, grace, screen-lock race
  test/meetings.test.js         node:test — code format, payload validation
  scripts/race-check.js         two real socket clients race for 1 seat against the running server
web/
  components.json, lib/utils.ts shadcn setup
  lib/brand.ts                  { product: 'Zylo', meet: 'ZyloMeet', call: 'ZyloCall', room: 'ZyloRoom', live: 'ZyloLive', chat: 'ZyloChat' }
  proxy.ts                      clerkMiddleware route protection
  app/layout.tsx                <ClerkProvider appearance>, next/font Plus Jakarta Sans, Toaster, metadata title "Zylo"
  app/globals.css               Tailwind v4 + shadcn tokens (light :root, .dark) from the design system
  app/page.tsx                  Zylo landing
  app/sign-in/[[...sign-in]]/page.tsx, app/sign-up/[[...sign-up]]/page.tsx
  app/dashboard/page.tsx        from dashboard-01 block: ZyloCall/ZyloMeet actions, Live now, ZyloMeet Tabs, ScheduleDialog
  app/m/[code]/page.tsx         state machine: prejoin → waiting → ZyloRoom (dark) → ended/removed/denied
  components/ui/*               shadcn primitives (generated)
  components/MeetingRow.tsx, ScheduleDialog.tsx, PreJoin.tsx, WaitingCard.tsx,
  components/VideoStage.tsx, ControlBar.tsx, PeoplePanel.tsx (incl. lobby + host menu), ChatPanel.tsx
  lib/api.ts                    apiFetch with Clerk token
  lib/useMeeting.ts             socket: admission state, presence, lobby, settings, ZyloLive lock, ZyloChat
  lib/useLiveKitRoom.ts         connect, speaker-view subscriptions (ported), screen publish
```

## Phases

Each phase ends with its acceptance list, plus for any UI the plugin's pre-delivery checklist, before
the next phase starts.

### Phase 1 — Setup, design system, login, dashboard (ZyloCall + ZyloMeet)
1. `git init`, `.gitignore`, copy docs. Save this spec to `docs/superpowers/specs/2026-09-14-zylo-design.md` and commit.
2. **Persist the design system.** Run the `--design-system` command above with
   `--persist -p "Zylo" --output-dir ~/Documents/Claude_WebRtc`, then again with `--page dashboard`
   and `--page meeting-room`. Add the dark palette, status colors and the naming table to MASTER.md.
3. Add `docker-compose.yml` and root scripts, then run `npm run db:up`.
4. **User step:** create a Clerk app named "Zylo" (Email + Google) and put the keys in `server/.env`
   and `web/.env.local`.
5. Scaffold web:
   - `npx create-next-app@latest web --ts --app --eslint --tailwind --no-src-dir --import-alias "@/*"`
   - `npx shadcn@latest init`, then add the `dashboard-01` block and the primitives listed above.
   - `npm i @clerk/nextjs socket.io-client livekit-client @livekit/components-react`
   Check the installed `.d.ts` files before coding against Clerk or LiveKit.
6. Scaffold server: `npm i express cors dotenv socket.io pg @clerk/express @clerk/backend livekit-server-sdk`.
7. Server: `db.js`, `schema.sql`, `auth.js`, `meetings.js` (all REST except livekit-token). Missing
   env → loud warning plus `503`, never a crash or fake data.
8. Web:
   - `brand.ts`, tokens in `globals.css`, font, themed Clerk.
   - Zylo landing, sign-in and sign-up pages.
   - Dashboard (customized block, ZyloCall button, ZyloMeet `ScheduleDialog` + Tabs, `MeetingRow`,
     join-with-code, skeletons, empty states).
   - `/m/:code` pre-join ("Join ZyloRoom"). Stop preview tracks on leave or unmount.

**Acceptance:**
- Signed out → redirected to sign-in.
- Start a ZyloCall, and schedule a ZyloMeet inviting user B; both appear correctly on A's and B's dashboards.
- B's `DELETE` via curl → `403`. No token → `401`.
- `node --test` passes, `next build` passes, and the server boots without `.env`.
- The plugin's pre-delivery checklist passes on the landing, auth, dashboard and pre-join pages at
  375 / 768 / 1024 / 1440.

### Phase 2 — ZyloRoom admission & seats (no media yet)
1. `seats.js` plus its tests, written first. Cover the race, the reserved host seat, FIFO positions,
   grace reconnect, the two-tab takeover, and switching manual → auto.
2. `room.js`: join-request, presence, lobby admit/deny, `host:set-admission`, the host check,
   lifecycle, and the boot sweep.
3. Web: `useMeeting.ts`, `WaitingCard`, and the dark ZyloRoom shell whose `PeoplePanel` includes the
   host's lobby with Admit / Deny and the admission setting.

**Acceptance** (use `maxParticipants = 3`):
- Host plus one participant seated. `scripts/race-check.js`: two users request together → exactly one
  admitted, the other `waiting { position: 1 }`. The seated participant leaves → the waiting user is
  admitted after the grace period.
- Manual: joiners wait, the host admits them, and "full" is refused.
- A non-host `lobby:admit` → `error:forbidden`.
- Everyone leaves → the meeting shows in ZyloMeet → Previous with duration and participants.

### Phase 3 — ZyloRoom video on LiveKit (up to 20) + ZyloChat
1. Run `livekit-server --dev`. `livekit.js`: `createRoom` with `maxParticipants`, plus token minting
   that requires a seat and not being removed.
2. `useLiveKitRoom.ts`: port the speaker view (audio always on, live video for the 5 most-recent
   speakers, `autoSubscribe: false`, `adaptiveStream`, `dynacast`), starting from the pre-join mic/cam choice.
3. `VideoStage` (tile grid, speaking ring, avatar fallback, `RoomAudioRenderer`), `ControlBar`
   (mic / camera / ZyloChat / leave), and `ChatPanel` for human **ZyloChat**.

**Acceptance:**
- 3–4 browser profiles see and hear each other, and ZyloChat messages reach only seated members.
- A token request without a seat → `403`.
- A 21st connection is refused.
- Leaving and rejoining within 30 s keeps the seat.
- The pre-delivery checklist passes on ZyloRoom.

### Phase 4 — Host controls + ZyloLive (screen share)
1. Server: `host:kick`, `host:mute`, `host:set-screen-policy`, `host:stop-share`, `host:end-meeting`,
   and the ZyloLive lock and permission grant/revoke flow.
2. Web:
   - `PeoplePanel` host menu (Mute / Stop ZyloLive / Kick with `AlertDialog`), ZyloLive-policy
     setting, and End for all.
   - ZyloLive button, presenting stage + banner + filmstrip, and toasts ("ZyloLive is in use by
     Priya" / "Only the host can use ZyloLive").
3. Verify that revoking a single source unpublishes the track, or use the fallback.

**Acceptance:**
- Two people press ZyloLive at the same instant (scripted) → exactly one granted.
- The sharer closes their tab → the lock frees.
- The host stops a ZyloLive share and kicks someone; the kicked user can't rejoin or get a token.
- A participant sending `host:*` → `forbidden`. With policy `host_only`, their request is denied.
- End for all → everyone sees the ended screen, and the meeting appears in Previous.

### Phase 5 — UI/UX polish and responsiveness
- A video grid that fits the number of people in the room at every screen size (best-fit columns,
  no scrolling until tiles would drop under 120px wide).
- The room is exactly one screen tall; the control bar fits one row at 320px.
- Responsive audit at 320, 375, 480, 768, 1024, 1025 and 1440px: no horizontal scroll anywhere.
- A ZyloChat toast for new messages while chat is closed.
- "Mute for me" in the People list: local-only, never sent to the server.
- Plan: `docs/superpowers/plans/2026-09-23-zylo-phase-5.md`.

### Phase 6 — Zylo Translator Convo (1-on-1 real-time translation)
- A `zylo-translator-convo` route: a 2-person meeting (`max_participants = 2`) shared by link.
- Browser speech recognition → translation (Chrome's on-device Translator API, MyMemory as the
  fallback) → `speechSynthesis` in the listener's language. Zero cost, no server-side AI.
- Planned after Phase 5 ships.

### Phase 7 — Hardening, load test, deploy
- **Rate limits** keyed on userId: join requests, token route, ZyloChat, and failed code lookups
  (plan.md 7d-style escalating backoff).
- **Graceful shutdown** on `SIGTERM`, and **structured logs** with meetingId and userId.
- **Load test for 15–20 people:**
  - `lk load-test` against local LiveKit with 20 participants and 5 video publishers.
  - About 8–10 real Chrome instances with fake media running Zylo.
  - Record connection time, CPU and memory, and data per person-hour in `LOAD_TEST_RESULTS.md`,
    including anything that broke.
- **Deploy:** Vercel (web), Railway or Fly (server), managed Postgres, LiveKit Cloud free tier. With
  more than one server instance, move seats and the lock to Redis.

### Phase 8 — AI in ZyloChat (Grok) — last, known issues to fix first
- `server/lib/ai.js` (sketch in plan.md Phase 0).
- `ai:message` → `ai:chunk` / `ai:done` streamed into ZyloChat for every seated member.
- 1 request per 3 s per user, 2,000-character cap, mediator prompt.
- `ai:error` when `XAI_API_KEY` is missing; never a fake reply.
- AI bubbles use the secondary indigo tint.
- Confirm the current model slug on console.x.ai first.

### Phase 9 — Proactive stuck detection
- Follows plan.md Phase 4: LiveKit active-speaker silence plus text heuristics → Grok judgment call
  posted into ZyloChat, with cooldown and a host-controlled snooze.

## Defaults chosen (change any before approving)

1. Everyone signs in; there's no guest join. Anyone signed in with the link can *request* to join a
   ZyloRoom. Invites only put the ZyloMeet on that person's Upcoming.
2. A ZyloCall starts in auto admission with ZyloLive set to anyone; the host can change both in the room.
3. The host can mute someone but can't force-unmute them.
4. A kicked user is blocked for that meeting only.
5. Previous meetings keep only metadata. ZyloChat messages are not stored.
6. The dashboard follows the system light/dark setting; ZyloRoom is always dark.
7. Not building: PDF or summaries, email sending, calendar sync, recurring meetings, recording, or
   editing a meeting.

## Verification

- **Automated:** `node --test server/test`, `node server/scripts/race-check.js`,
  `npm --prefix web run build`, and `node server/server.js` booting with missing env.
- **Manual, each phase:** its acceptance list in several Chrome profiles, plus curl or socket scripts
  for every `401`/`403`/`forbidden` check.
- **UI quality, each UI phase:**
  - Screenshots in the in-app Browser pane at 375 / 768 / 1024 / 1440.
  - The ui-ux-pro-max pre-delivery checklist: no emoji icons, pointer cursor, 150–300 ms hover
    transitions, 4.5:1 contrast in light and dark, visible focus rings, reduced motion respected,
    44px targets, labels on icon buttons.
  - A Lighthouse accessibility audit on the dashboard and ZyloRoom.
  - Brand names match the naming table.
- Tick a phase in `docs/plan.md` only after its acceptance list passes. Keep `docs/architecture.md`
  describing what's actually built.

## After approval

Following brainstorming → writing-plans:
1. Save this spec into the repo.
2. Run writing-plans to break Phase 1 into tasks.
3. Build Phase 1, using ui-ux-pro-max for every UI task.
4. Stop for review before Phase 2.
