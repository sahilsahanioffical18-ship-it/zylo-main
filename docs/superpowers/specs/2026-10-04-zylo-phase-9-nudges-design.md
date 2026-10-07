# Zylo Phase 9: AI nudges (proactive stuck detection)

Approved in chat on 2026-10-04. Builds on Phase 8 (Zylo AI in ZyloChat). Work happens in the `phase-9-nudges` worktree (`.worktrees/phase-9-nudges`), branched from `phase-8-ai`; once PR #8 is merged, Phase 9 is rebased onto `main` if needed.

Original intent (2026-09-14 design spec, "Phase 9", and `docs/plan.md` "Proactive stuck-detection (no STT)"): LiveKit active-speaker silence plus text heuristics → an AI judgment call posted into ZyloChat, with a cooldown and a host control. There is no speech-to-text: the AI never hears the call. Described honestly, the feature is "Zylo AI notices when the room goes quiet or the chat stalls, and offers a nudge".

Out of scope: a sensitivity slider, a per-person snooze, stuck phrases in languages other than English, anything that needs speech-to-text, nudges in Translator Convo, saving nudges after a meeting.

---

## 1. Decisions made with the user

| Question | Decision |
|---|---|
| When the AI speaks up | **Quiet room + stuck chat**: nobody spoke or typed for 60 s, someone typed a stuck phrase, or the chat goes in circles. |
| Default | **Off**; the host turns "AI nudges" on per meeting. "AI in chat" off also means no nudges. |
| Who decides | **The AI decides** and may stay silent (`NO_NUDGE`); nothing canned is ever posted. |
| How it looks | The Zylo AI bubble with a caption saying **why it spoke** ("AI noticed: quiet for a while"). |
| Where it runs | **On the server** (approach A): browsers report their own person's speech as a timestamp; chat triggers run when a line arrives; the quiet check runs in the existing sweep; a Redis claim makes one server act. |

## 2. Signals

All four live in the room's meta hash (`zylo:room:{code}:meta`), written by one small store script that changes nothing if the meta key doesn't exist (so a write can never recreate a cleared room). Times are the writing server's `Date.now()`; a few seconds of clock difference between servers doesn't matter against a 60 s threshold.

- `lastVoiceAt` — the last time any seated person spoke.
  - Every 2 s the browser checks LiveKit's `room.localParticipant.isSpeaking` (polled, not the `ActiveSpeakersChanged` event, which fires only on changes and could miss a long monologue). While **its own** participant is speaking, it emits `voice:activity` (no payload), at most once every **10 s**, and only while nudges are effectively on for this meeting (`aiNudges && aiEnabled && aiAvailable`). No audio and no text leaves the browser — only the fact "I spoke just now".
  - Server: per-socket limit `voice:activity { rate: 0.2, burst: 2 }`, refused **silently** (no `rate-limited` toast — it's background traffic); the socket must own its seat (`seatFor`, `seat.socketId === socket.id`), else dropped; translator meetings ignored. Then the script sets `lastVoiceAt` and clears `quietNudged`.
- `lastChatAt` — the last time a person's chat line was relayed (every `chat:message`, including questions to the AI; AI answers and nudges never count). Set by the same script after the line is delivered; it clears `quietNudged` too. A failed write is logged and never blocks chat.
- `nudgesOnAt` — when nudges were last switched on for this meeting (set by `host:set-nudges { enabled: true }`, by `host:set-ai { enabled: true }` since turning AI back on also turns nudges back on, and by `initMeta` when the meeting row already has nudges on). The quiet clock starts here, so switching nudges on in a meeting that's been quiet for ten minutes doesn't fire at once.
- `quietNudged` — `'1'` once a quiet nudge has been claimed for the current quiet stretch; cleared by any new speech or chat line.

## 3. Triggers

Nudges are **effectively on** only when all of these hold: the meeting's `aiNudges` is on, its `aiEnabled` is on, the server has an AI client (`createAi` returned non-null), and the meeting isn't a Translator Convo. Otherwise no check runs and nothing is read beyond the meta.

Both chat triggers skip lines sent with Ask AI (`toAi`): the AI is already answering that person. Those lines still count as activity (`lastChatAt`).

1. **Stuck phrase** (`reason: 'stuck'`), checked after a chat line is relayed and remembered. The line (lower-cased, whitespace collapsed) matches one of: `i'm stuck` / `im stuck` / `we're stuck` / `were stuck`, `i don't know` / `i dont know` / `idk`, `no idea`, `not sure`, `i'm lost` / `im lost`, or the whole line is only question marks (`??` or more) or only `hm`/`hmm`/`hmmm…`. Matched as whole words (`\b`), case-insensitive; curly apostrophes count as straight ones.
2. **Going in circles** (`reason: 'circles'`), checked at the same point. Take the last 3 **human** lines from the chat history (the new line included). Each must have at least 3 words; every pair's word-set overlap (Jaccard: |A∩B| / |A∪B| over lower-cased words, punctuation stripped) must be **> 0.6**.
3. **Quiet room** (`reason: 'quiet'`), checked by every server's existing 15 s sweep, for each live meeting. All must hold:
   - nudges effectively on;
   - `quietNudged` isn't set;
   - `now - max(lastVoiceAt, lastChatAt, nudgesOnAt) >= 60_000` (missing fields count as 0, but `nudgesOnAt` is always set when nudges are on);
   - at least **2 people are seated**;
   - the chat history holds at least **2 human lines** (the AI only reads chat; with less it has nothing useful to say).

   The cheap meta checks come first; seats and history are only read when they pass. A failing quiet check for one meeting is logged and never stops the sweep.

If more than one trigger matches one chat line, `stuck` wins over `circles`.

## 4. Firing a nudge

1. **Claim**: `SET zylo:room:{code}:nudge 1 NX PX 90000`. Not set → stop (another server is on it, or the 90 s cooldown is running). The claim stands even if the AI then stays silent, so a meeting is asked at most once per 90 s. The key shares the room's `{code}` hash tag and simply expires; ending a meeting needs no change (an ended code never reopens).
2. For `quiet`: set `quietNudged = '1'` right after a successful claim (one quiet stretch → one claim).
3. **Deployment limit**: shared policy `aiNudgeAll { rate: 1, burst: 5 }` keyed on the whole deployment (like `googleAll`). Refused → stop, quietly.
4. **Ask the AI** through Phase 8's client, not streamed to anyone: `ai.stream({ messages, system: NUDGE_PROMPT(reason), maxTokens: 200, signal })` collects the whole answer (the existing 30 s cap applies). `stream` gains optional `system` and `maxTokens`; Ask AI's defaults are unchanged. `messages` is the last 20 chat lines in Phase 8's transcript format (flattened names and text, 500-character cut, well-formed), with no question line.
5. **Decide**: if the answer contains `NO_NUDGE` anywhere, or is empty after trimming → nothing is posted. A provider error, non-200, timeout or abort → logged on the server only, nothing posted.
6. **Re-check, then post**: re-read the meta. If the meeting has ended or nudges are no longer effectively on → drop it. Otherwise emit `ai:nudge { id, text, reason, ts }` to the room (`io.to(roomChannel(code))`; `id` random, like Ask AI's) and add `{ name: 'Zylo AI', text, ai: true }` to the chat history so a later Ask AI sees it. A nudge never touches `lastChatAt` or `quietNudged`.

Nudge calls run outside the chat handler and the sweep (neither waits for the provider), and join Ask AI's in-flight set so `stop()` aborts them on shutdown.

## 5. What the AI is told

`NUDGE_PROMPT(reason)`, verbatim apart from the reason clause:

> You are Zylo AI, a shared assistant inside a live video meeting. Nobody asked you anything: you are speaking up because {reason clause}. You only see the chat text below; you cannot hear the call or see video, so never claim to. If a short nudge would help the group move forward, reply with one or two plain, concrete sentences based on the chat — for example a question that unblocks them, a summary of where they are, or the one point they actually disagree on. If speaking up wouldn't help, reply with exactly NO_NUDGE.

Reason clauses: `quiet` → "nobody has spoken or typed for a minute"; `stuck` → "someone just wrote that they are stuck or unsure"; `circles` → "the last few chat messages repeat the same point".

Cost bounds: at most one nudge call per meeting per 90 s, one per quiet stretch, 200 output tokens each, and `aiNudgeAll` across the deployment.

## 6. The host setting

Same shape as Phase 8's "AI in chat":

- Postgres: `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_nudges BOOLEAN NOT NULL DEFAULT false` (idempotent, in `server/db/schema.sql`).
- Room store: meta gains `aiNudges` (`'1'`/`'0'`, missing reads **false**), `nudgesOnAt`, `lastVoiceAt`, `lastChatAt`, `quietNudged`; `initMeta` takes `aiNudges` from the meeting row (and stamps `nudgesOnAt` when it's on); `getMeta` returns `aiNudges` as a boolean plus the three times as numbers (0 when missing) and `quietNudged` as a boolean.
- `host:set-nudges { enabled: boolean }` behind `hostGuard`: non-boolean → ignored; translator meeting → ignored; writes Redis meta (switching on also stamps `nudgesOnAt`) then Postgres; broadcasts `meeting:settings`.
- `meeting:settings` gains `aiNudges` on every emit: the host setting changes, and the one admission sends.
- The meeting card (`GET /api/meetings/:id` and the dashboard cards) gains `aiNudges: boolean`.

## 7. The web app

- `web/lib/use-livekit-room.ts`: every 2 s, if `room.localParticipant.isSpeaking`, call an `onLocalSpeech` callback. A pure throttle helper (`shouldReportSpeech(lastAt, now)`, 10 s) decides; `use-meeting.ts` emits `voice:activity` only while nudges are effectively on.
- `web/lib/ai-chat.ts`: the reducer handles `ai:nudge` by adding a finished Zylo AI item carrying `nudge: 'quiet' | 'stuck' | 'circles'`; a repeated id is ignored. Nudge captions (typographic apostrophes, like the rest of the UI):
  - quiet → "AI noticed: quiet for a while"
  - stuck → "AI noticed: someone said they’re stuck"
  - circles → "AI noticed: the chat is going in circles"
- `chat-panel.tsx`: the nudge renders in the same indigo Zylo AI bubble, plain text, with the caption above it in small muted text. It follows the same scroll rule as answers.
- Pop-up and screen readers: with chat closed, a nudge shows the same single "Zylo AI" pop-up as a finished answer; the live region announces it once.
- `people-panel.tsx` / `choice-group.tsx`: the host sees an **AI nudges** On/Off setting under "AI in chat". Hints: On → "Zylo AI may speak up when the chat stalls or the room goes quiet."; Off → "Zylo AI only answers when asked." Hidden in Translator Convo; disabled with "Turn on AI in chat first" while AI in chat is off. Everyone else sees no setting.

## 8. Failure behaviour (never a fake nudge)

| Situation | Behaviour |
|---|---|
| Nudges off, AI in chat off, no AI key, Translator Convo | No checks, nothing posted. |
| Redis down | Rooms already fail closed. A failed signal write is logged once per outage and never blocks chat; that sweep pass skips the quiet check. |
| Claim not won / cooldown running / `aiNudgeAll` refused | Skipped silently. |
| Provider error, non-200, timeout, empty answer, `NO_NUDGE` | Nothing posted; errors logged on the server only; the claim stands (no retry loop). |
| Meeting ended or nudges switched off while the AI was thinking | The nudge is dropped. |
| Server shutting down | In-flight nudge calls are aborted with Ask AI's `stop()`. |
| A non-host sends `host:set-nudges`, or an unseated socket sends `voice:activity` | Ignored, like every other host and seat check. |

## 9. Testing

`node:test` with Phase 8's fake AI server and the real test Redis (database 1).

- **Pure** (`server/lib/nudge.js`): `stuckPhrase(text)` (each phrase, whole-word matching, curly apostrophes, `??`/`hmm` lines, non-matches like "stuckey" or "I know"); `goingInCircles(lines)` (3-word minimum, the 0.6 boundary, fewer than 3 lines); `isQuiet(meta, now, seated, humanLines)` (the 60 s boundary, `nudgesOnAt` starting the clock, `quietNudged`, 2 seated, 2 human lines).
- **Socket**: "I'm stuck" → every member gets `ai:nudge { reason: 'stuck' }` once; repeated lines → `circles`; the AI answers `NO_NUDGE` → nothing posted; a second trigger inside 90 s → no provider call; nudges are off by default and a non-host can't switch them on; `voice:activity` from a seated socket sets `lastVoiceAt` and clears `quietNudged`, from an unseated one does nothing; the quiet sweep fires once per quiet stretch and again only after new activity plus a new quiet minute; two servers on one Redis → one nudge, provider called once; a nudge is added to the history; turning nudges off while the provider is answering drops the nudge; no checks in a Translator Convo; a failing provider posts nothing.
- **Web**: reducer tests for `ai:nudge` (adds a done item with its reason, ignores a repeated id, respects the item cap); `shouldReportSpeech` boundaries; `tsc`, `lint`, `build`.
- **Manual** (the plan's last task, added to the test sheet): turn nudges on, type "I'm stuck" → a captioned nudge on both devices; go quiet for a minute after chatting → one quiet nudge; stay quiet longer → no second one; talk, then go quiet again → another; host turns nudges off → none; non-host sees no setting; Translator Convo has none.

## 10. Files

- New: `server/lib/nudge.js` (phrases, overlap, quiet rule, `NUDGE_PROMPT`), `server/test/nudge.test.js`, `server/test/aiNudges.test.js`.
- Server changes: `server/lib/ai.js` (`stream` takes optional `system` and `maxTokens`), `server/lib/room.js` (`voice:activity`, the chat and sweep checks, firing, `host:set-nudges`, settings payloads), `server/lib/roomStore.js` (meta fields and the touch-if-exists script), `server/lib/rateLimit.js` (`aiNudgeAll`, `voice:activity`), `server/db/schema.sql`, `server/lib/meetings.js` (card field).
- Web changes: `web/lib/use-livekit-room.ts`, `web/lib/use-meeting.ts`, `web/lib/ai-chat.ts` (+ test), `web/lib/types.ts`, `web/components/chat-panel.tsx`, `web/components/people-panel.tsx`, `web/components/choice-group.tsx`, `web/components/meeting-room-flow.tsx`.
