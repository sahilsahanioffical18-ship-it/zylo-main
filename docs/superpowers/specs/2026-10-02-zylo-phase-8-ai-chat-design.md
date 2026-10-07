# Zylo Phase 8: AI in ZyloChat

Approved in chat on 2026-10-02. Builds on Phase 7 (Redis, rate limits, rooms on Redis). Work happens in the `phase-8-ai` worktree (`.worktrees/phase-8-ai`), branched from `phase-7-redis`; once Phase 7 is merged, Phase 8 is rebased onto `main`.

Original intent (2026-09-14 design spec, "Phase 8"): `ai:message` streamed into ZyloChat for every seated member, a per-user limit, a 2,000-character cap, a mediator prompt, an error when no key is set (never a fake reply), AI bubbles in the secondary indigo tint. This spec keeps all of that and fixes the details below.

Out of scope: AI that speaks up on its own (Phase 9, stuck detection), AI in Translator Convo, saving AI answers after a meeting, showing earlier chat to people who join late.

---

## 1. Decisions made with the user

| Question | Decision |
|---|---|
| Provider | Any **OpenAI-compatible** chat API, chosen in `.env`. The user will use a Grok (xAI) key or NVIDIA's free API. |
| How to ask | An **Ask AI** button next to Send. |
| What the AI sees | The question **plus the meeting's last 20 chat messages** (AI answers included). |
| Who can ask | **Everyone seated**; the **host can turn AI off** per meeting (on by default). |
| Delivery | **Streamed** word by word to everyone, plus the complete text at the end. |

## 2. Provider and configuration

Three variables in `server/.env`:

| Variable | Meaning | Example |
|---|---|---|
| `AI_BASE_URL` | OpenAI-compatible base URL. Defaults to `https://api.x.ai/v1` when unset. | `https://api.x.ai/v1` or `https://integrate.api.nvidia.com/v1` |
| `AI_API_KEY` | Bearer key (`Authorization: Bearer …`). | `xai-…` or `nvapi-…` |
| `AI_MODEL` | Model id. **No built-in default**: older Grok slugs silently bill at flagship rates, so the model is always named explicitly. | `grok-4.3` (cheaper, $1.25 / $2.50 per million tokens in / out), `grok-4.7` (best, $2 / $6), or `meta/llama-3.1-70b-instruct` (NVIDIA) |

- AI is **configured** only when both `AI_API_KEY` and `AI_MODEL` are set. Otherwise the server starts with one warning line ("AI_API_KEY or AI_MODEL is not set — Ask AI is off") and every question gets the not-configured error.
- `server/.env.example` documents all three, with the Grok and NVIDIA examples above (model facts checked on docs.x.ai on 2026-10-02).
- `/health` gains `"ai": true|false` — whether AI is configured. It never calls the provider (that would cost money).

## 3. How a question flows

1. The client emits `ai:ask { text }`.
2. The server's handler (`room.js`), in this order:
   1. `socket.data.meetingId` hint present, else drop.
   2. Shared rate limit `aiUser` (per user id; Phase 7 policy: rate 0.1/s, burst 3). Refused → `rate-limited { event: 'ai:ask' }` to the asker. This comes before any room-store read so a flood costs one Redis call each.
   3. Text validated with the chat rule (`validateChatText`: trimmed, non-empty, ≤ 2,000 characters). Invalid → drop silently, like chat.
   4. The asker's seat is owned by this socket (store `seatFor`). Else drop.
   5. Meeting settings (store `getMeta`): translator mode → drop silently; `aiEnabled` false → `ai:error { reason: 'disabled' }` to the asker.
   6. AI configured, else `ai:error { reason: 'not_configured' }` to the asker.
   7. Shared rate limit `aiRoom` (per meeting; rate 0.1/s, burst 6). Refused → `rate-limited { event: 'ai:ask' }`.
3. The question is posted to the room as a normal chat message with a marker: `chat:message { userId, name, text, ts, toAi: true }`, and added to the chat history (§4).
4. Before step 3, the server reads the 20 earlier history lines (a failed read drops the question before anything is posted); the AI gets those lines plus the question last. It emits `ai:start { id, askedBy: { userId, name }, ts }` to the room and calls the provider with streaming on.
5. Each text piece → `ai:chunk { id, delta }` to the room. Pieces are batched to at most one emit per 100 ms per answer, so a fast stream doesn't flood the adapter.
6. When the stream ends → `ai:done { id, text, ts }` to the room (`text` is the full answer, so a client that missed pieces still ends with the right text), and the answer is added to the history as `{ name: 'Zylo AI', text, ai: true }`.
7. On a provider error, a non-200 answer, an empty answer or the 30-second timeout → `ai:failed { id, message: "The AI couldn't answer. Try again." }` to the room. Nothing is added to the history. The provider's error is logged on the server only.

`id` is a random id per answer. Two people asking at once produce two independent answers; the per-meeting limit bounds the cost.

All room emits go through `io.to(roomChannel(code))`, so the Phase 7 Redis adapter delivers them to people on every API server. The stream runs on the asker's server; if that server dies mid-answer, clients fail the bubble themselves (§7).

## 4. Chat history for the AI

- New module `server/lib/chatHistory.js`, a thin wrapper on the shared Redis client:
  - `add(code, { name, text, ai = false })` — `RPUSH` the JSON entry to `zylo:chat:{<code>}`, `LTRIM` to the last 20, `EXPIRE` 6 hours; one `MULTI`.
  - `recent(code)` — the entries, oldest first.
  - `clear(code)` — `DEL`.
- Every relayed `chat:message` (normal or `toAi`) is added. A history failure is logged and never blocks the chat relay.
- The key lives **outside** the room-state Lua scripts on purpose: they all take exactly the 7 room keys, and this list needs none of their atomicity. It has a TTL (unlike room keys) because it is disposable context, and `volatile-lru` may evict it under memory pressure — the AI then just sees less history.
- Cleared whenever a meeting ends: `endEmptyRoom`, `host:end-meeting`, and the sweeper's ends.

## 5. What the AI is told

The request is `POST {AI_BASE_URL}/chat/completions` with `stream: true`, `max_tokens: 600`, and these messages:

1. **System** (fixed text, kept in `server/lib/ai.js`):
   > You are Zylo AI, a shared assistant inside a live video meeting. Everyone in the meeting sees your reply at the same time. Answer in plain, short, concrete language — a few sentences or a short list. You only see the chat text below; you cannot hear the call or see video, so never claim to. When participants disagree, don't declare a winner unless it's a verifiable fact; instead, name the specific point their views actually differ on, so the group can settle it themselves.
2. **One user message** containing the recent chat as a transcript (`Name: text` per line; AI answers as `Zylo AI: text`), each line cut to its first 500 characters, followed by the asker's question on the last line.

Parsing the stream (server-sent events): read `data:` lines; skip `[DONE]`, unparseable lines and events whose `choices` is missing or empty (heartbeats — the classic crash); use only `choices[0].delta.content`; ignore any reasoning/"thinking" fields.

`server/lib/ai.js` exports `createAi({ baseUrl, apiKey, model, fetchImpl = fetch })` → `null` when not configured, else `{ model, stream({ messages, onDelta, signal }) → Promise<fullText> }`. Plain `fetch`, no new dependency. The 30-second limit is an `AbortSignal.timeout(30_000)`.

## 6. The host setting

- Postgres: `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true` (idempotent, in `server/db/schema.sql`, same pattern as `mode`).
- Room store: the meta hash gains `aiEnabled` (`'1'`/`'0'`); `initMeta` takes it from the meeting row; `getMeta` returns a boolean. Only the init script changes.
- `host:set-ai { enabled: boolean }` behind `hostGuard` (which also rate-limits host events): non-boolean → ignored; translator meeting → ignored; writes Redis meta then Postgres; broadcasts `meeting:settings { admission, screenSharePolicy, aiEnabled }`. The two existing `meeting:settings` emits also gain `aiEnabled`. Admission also sends the current `meeting:settings` to the person being admitted, before `meeting:admitted`, so a setting changed while they were on pre-join, in the lobby or reconnecting isn't stale.
- An answer already streaming finishes; new questions are refused with `ai:error { reason: 'disabled' }`.
- The meeting card (`GET /api/meetings/:id` and the dashboard cards) gains `aiEnabled: boolean` and `aiAvailable: boolean` (server configured), so the room knows the button's state before any socket event.

## 7. The web app

- **`web/lib/ai-chat.ts`** (pure, unit-tested): the chat list's item type becomes a union — a person's message (now with optional `toAi`) or an AI answer `{ kind: 'ai', id, askedBy, text, status: 'thinking' | 'streaming' | 'done' | 'failed', ts }` — plus a reducer applying `ai:start` / `ai:chunk` / `ai:done` / `ai:failed`, and the 45-second stall rule (no chunk for 45 s → `failed`). `ai:done` always replaces the text with the full answer.
- **`use-meeting.ts`**: listens to the four `ai:*` events and `ai:error`, exposes `askAi(text)`, `setAiEnabled(enabled)`, and `aiEnabled` from `meeting:settings`. `rate-limited { event: 'ai:ask' }` gets its own wording in `web/lib/rate-limit.ts` ("You're asking the AI too often. Wait a moment.").
- **Chat panel**:
  - A sparkle **Ask AI** button between the text box and Send. Enter still sends normal chat. It sends the same draft through `askAi`.
  - Disabled with a reason when AI isn't available: "AI isn't set up on this server" (`aiAvailable` false) or "The host turned AI off" (`aiEnabled` false) — a tooltip on desktop, a short line under the box when tapped on a phone.
  - A question shows as the person's normal bubble with a small "→ Zylo AI" tag.
  - An answer bubble: label **Zylo AI** with a sparkle icon, background in the **secondary** token (indigo tint, both themes); "Thinking…" with animated dots before the first piece (respects reduced motion), then text with a blinking cursor while streaming, plain text when done, muted red "The AI couldn't answer. Try again." when failed.
  - Answers render as plain text (no Markdown, no HTML) — safe by construction.
  - Screen readers: the answer bubble is not a live region while streaming; the finished answer is announced once.
- **Chat closed**: the existing chat pop-up fires once per answer on `ai:done`, titled "Zylo AI" with the answer's first line.
- **People panel (host only)**: "AI in chat" with **On / Off**, same component and style as Admission. Hidden in Translator Convo.
- **Translator Convo**: no Ask AI anywhere (its chat button already opens Captions).

## 8. Failure behaviour (never a fake reply)

| Situation | Asker sees | Everyone else sees |
|---|---|---|
| No key or model | "AI isn't set up on this server." (button already disabled) | nothing |
| Host turned AI off | "The host turned AI off." | nothing |
| Too many questions | "You're asking the AI too often. Wait a moment." | nothing |
| Provider error / non-200 / empty / 30 s timeout | failed bubble | the same failed bubble |
| Asker's server dies mid-answer | bubble fails after 45 s without a piece | the same |
| Redis down | Phase 7 rules: store reads fail → the question is dropped and logged; the call continues | nothing |

## 9. Testing

- **Server unit** (`ai.test.js`) against a fake OpenAI-compatible server (a local `http` server streaming SSE): pieces arrive in order and the full text is returned; empty-`choices` heartbeats and reasoning-only pieces are skipped; `[DONE]` ends the stream; non-200 and malformed responses reject; a hung upstream rejects at the timeout; the request carries `Authorization: Bearer`, the model, `stream: true`, `max_tokens: 600` and the system prompt; `createAi` returns `null` without a key or model.
- **`chatHistory.test.js`** (Redis db 1): keeps the last 20, oldest first, 6 h TTL, `clear` deletes.
- **Socket** (`aiChat.test.js`, room harness with the fake provider): a seated user's question reaches everyone as `chat:message { toAi: true }`, then `ai:start` → `ai:chunk`s → `ai:done` with the identical full text for every member; the AI request includes the last 20 history lines and the question; lobby and replaced sockets are ignored; translator meetings ignore `ai:ask`; `aiEnabled` off → `ai:error { reason: 'disabled' }` and no provider call; no AI configured → `ai:error { reason: 'not_configured' }` and no provider call, never any `ai:chunk`; `aiUser` and `aiRoom` refusals → `rate-limited { event: 'ai:ask' }`; provider failure and timeout → `ai:failed` to everyone and nothing added to history; `host:set-ai` is host-only, persists to Postgres and broadcasts `meeting:settings`; ending a meeting clears the history.
- **Multi-server** (`multiServer.test.js`): a question asked on server A streams to a member on server B.
- **Web unit** (`ai-chat.test.ts`): the reducer (start/chunk/done/failed, out-of-order and duplicate events, `done` overriding missed chunks) and the 45-second stall rule.
- **Manual (test sheet, Phase 8 section)**: with a real Grok or NVIDIA key — ask from Mac and phone, both see the same stream; follow-up questions use earlier answers; the host turns AI off and on; no key → clear error.

## 10. Files

| File | Change |
|---|---|
| `server/lib/ai.js` (new) | OpenAI-compatible streaming client and the system prompt |
| `server/lib/chatHistory.js` (new) | Last-20 chat history in Redis |
| `server/lib/room.js` | `ai:ask`, `host:set-ai`, history on chat, `aiEnabled` in settings emits, history cleared on end |
| `server/lib/roomStore.js` | `aiEnabled` in meta (init script + `getMeta`) |
| `server/lib/meetings.js` | `aiEnabled`, `aiAvailable` on meeting cards |
| `server/db/schema.sql` | `ai_enabled` column |
| `server/app.js`, `server/server.js` | Create `ai` and the history, pass them on; `/health.ai`; startup warning |
| `server/.env.example` | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` |
| `web/lib/ai-chat.ts` (new) | Chat item types, AI reducer, stall rule |
| `web/lib/use-meeting.ts`, `web/lib/rate-limit.ts`, `web/lib/types.ts` | Events, actions, wording, card fields |
| `web/components/chat-panel.tsx`, `room-shell.tsx`, `people-panel.tsx`, `meeting-room-flow.tsx` | Ask AI button, AI bubble, host setting, wiring |
| Tests | as in §9 |
