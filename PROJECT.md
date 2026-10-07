# Zylo Project Overview

## What Zylo Is

Zylo is a host-controlled video meeting application. People can create or schedule
meetings, join a room, participate in live video calls, chat, and use a live
translator conversation mode.

## Product Areas

- **ZyloCall**: start an instant meeting.
- **ZyloMeet**: schedule and manage meetings.
- **ZyloRoom**: the in-meeting experience, including admission, video, and host
  controls.
- **ZyloLive**: screen sharing with host-controlled permissions.
- **ZyloChat**: text chat for meeting participants.
- **Translator Convo**: live captions and translated speech for two people who
  speak different languages.

## Architecture

The repository has two applications:

- `web/`: Next.js App Router application built with React, TypeScript, Tailwind
  CSS, and shadcn/ui.
- `server/`: Node.js CommonJS application using Express and Socket.IO. It handles
  authentication, meeting APIs, admission, room events, and server-side
  authorization.

PostgreSQL stores users and meeting records. LiveKit provides real-time audio and
video. The browser handles translator speech recognition, translation, and
speech synthesis where supported, with a translation API fallback for unsupported
language pairs.

## Technology

- Node.js 22
- Next.js 16, React 19, and TypeScript
- Express 5 and Socket.IO 4
- PostgreSQL 16
- Clerk authentication
- LiveKit for real-time media
- `node:test` for server and pure-module tests

## Development Roadmap

1. **Phase 1 - Foundation:** authentication, dashboard, meeting APIs, and the
   initial meeting flow.
2. **Phase 2 - Admission:** server-controlled seats, lobby queue, admission
   settings, and reconnect grace periods.
3. **Phase 3 - Live meetings:** LiveKit video and audio, participant chat, and
   speaker-focused video subscriptions.
4. **Phase 4 - Host controls:** participant moderation, meeting lifecycle controls,
   and ZyloLive screen sharing.
5. **Phase 5 - UI polish:** responsive room layout, participant controls, and
   meeting interface refinements.
6. **Phase 6 - Translator Convo:** two-person multilingual captions and translated
   speech.
7. **Phase 7 - Redis and rate limiting:** add Redis and rate limiting to improve
   shared runtime state and protect application endpoints and real-time events.
   Exact Redis key, expiry, and rate-limit policies will be defined in the Phase 7
   implementation plan.

## Run Locally

Prerequisites: Node.js 22+, Docker, and a Clerk application configured for the
web and server applications. LiveKit credentials are needed to use meeting media.

From the repository root:

```bash
npm run db:up
cp server/.env.example server/.env
cp web/.env.local.example web/.env.local
npm --prefix server install
npm --prefix web install
```

Add the required Clerk keys to the environment files. Then run the API and web app
in separate terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

The web app is served at `http://localhost:3000`; the API is served at
`http://localhost:4000`.

## Tests

```bash
npm --prefix server test
npm --prefix web test
npm --prefix web run lint
npm --prefix web run build
```