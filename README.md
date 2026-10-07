# Zylo

Video meetings where the host stays in control.

- **ZyloMeet** — schedule meetings and invite people by email
- **ZyloCall** — start an instant meeting
- **ZyloRoom** — host-controlled room for up to 20 people
- **ZyloLive** — screen sharing, one presenter at a time
- **ZyloChat** — in-meeting chat

> **Status:** Phase 1 — sign-in, dashboard, meetings API and ZyloRoom pre-join.
> Admission and seats (Phase 2), video on LiveKit (Phase 3) and host controls with ZyloLive (Phase 4) are next.
> Full design: [`docs/superpowers/specs/2026-09-14-zylo-design.md`](docs/superpowers/specs/2026-09-14-zylo-design.md)

## Stack

Next.js 16 · React 19 · Tailwind v4 · shadcn/ui · Clerk · Express 5 · PostgreSQL 16 · LiveKit (Phase 3)

## Run locally

Prerequisites: Node 22, Docker, and a [Clerk](https://clerk.com) application with Email and Google sign-in.

```bash
npm run db:up                              # starts Postgres and Redis
cp server/.env.example server/.env        # add CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY
cp web/.env.local.example web/.env.local  # add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY
npm --prefix server install
npm --prefix web install
npm run dev:server   # API on http://localhost:4000
npm run dev:web      # app on http://localhost:3000
```

## Test

```bash
npm run db:up               # server tests use the zylo_test database
npm --prefix server test
npm --prefix web test
npm --prefix web run build
npm --prefix server run load-check   # 20 simulated people on two API servers (not part of npm test)
```

## Deploy

[`docs/deploy.md`](docs/deploy.md) walks through Vercel (web), Railway (API, Postgres, Redis), LiveKit Cloud and Clerk, and ends with a post-deploy check.
