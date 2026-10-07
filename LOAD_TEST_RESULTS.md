# Zylo load test results

Run on 2026-10-05 on the `phase-10-deploy` branch at 909ec08 (the docs commit after it changed no code). Both tests run on one Mac.

## The machine

- MacBook Air (Mac15,12), Apple M3, 8 cores (4 performance and 4 efficiency), 8 GB
- macOS 26.6.2, Node v22.20.0 (the x64 build, so it ran under Rosetta; `npm run load-check` ran on it), lk version 2.18.8, livekit-server version 1.13.7

## 1. Video: `lk load-test` against `livekit-server --dev`

    lk load-test --dev --url ws://127.0.0.1:7880 --room load-test \
      --video-publishers 5 --audio-publishers 5 --subscribers 15 --duration 2m --yes

lk counts audio publishers as the same participants as the video publishers (a 2/2/1 trial run showed 3 participants), so this is the spec's 20: 5 publishing video and audio, 15 subscribing only. Video is lk's default: `high`, simulcast. `livekit-server`'s CPU and memory were sampled with `ps` every 5 s during the run (24 samples).

| | Result |
|---|---|
| Participants connected | 20 (5 publishers and 15 subscribers; lk printed "Finished connecting to room") |
| Tracks received (subscribers) | 150/150 (every one of the 15 subscribers received all 10 tracks) |
| Bitrate | 41.8 mbps in total across the 15 subscribers (2.8 mbps average each) |
| Packet loss | 0 (0%) |
| Errors | 0 |
| livekit-server CPU | 42.7 % average, 51.2 % peak (100 % = one core) |
| livekit-server memory | 166 MB peak RSS |

The load generator and the SFU share this one Mac, so these numbers are a floor, not LiveKit Cloud's capacity.

## 2. Zylo's server: `npm run load-check`

    cd server && npm run load-check

There are two API servers in one process. They share the local Redis (database 1) and the test Postgres database, with the test harness's fake sign-in and a fake streaming AI. The run:
- 20 people join one meeting, 10 on each server.
- They chat for 60 s, each sending a line every 5–10 s, plus one burst where everyone sends at once.
- One person asks the AI.
- Everyone sends `voice:activity` every 10 s.
- One server then stops with `shutdown()`, and its 10 people reconnect to the other.

| Step | Result |
|---|---|
| Join | 20/20 admitted, 20 seats held; join-request → admitted p50 99 ms, p95 112 ms, max 115 ms |
| Chat | 172 lines × 20 people, 0 lost; send → receive p50 9 ms, p95 31 ms, max 36 ms |
| Ask AI | `ai:done` exactly once for 20/20; question → last `ai:done` 559 ms |
| Speech reports | 140 `voice:activity` reports |
| Planned stop | `shutdown()` → 0 (`shutdown complete ms=34`); disconnect reasons: `transport close`; 10/10 seated again, 10 in the same seat; last one seated 139 ms after the stop |
| Cost | Redis 3913 commands in 72 s = 3277/min; process RSS peak 96 MB; CPU 2.2 s user + 0.7 s system |

The script prints nine pass marks; all nine passed (exit 0). The stop's mark is split into five:

| Pass mark | Result |
|---|---|
| All 20 seated | PASS |
| No chat line lost | PASS |
| 95th-percentile chat delivery under 200 ms | PASS (31 ms) |
| Everyone heard `ai:done` exactly once | PASS |
| `shutdown()` returned 0 | PASS |
| Every disconnect reason was `transport close` | PASS (10/10 heard) |
| The stopped server's people seated again | PASS (10/10) |
| All in the same seats | PASS (10/10) |
| The last one seated again within 10 s | PASS (139 ms after the stop) |

What the cost figures cover:
- **Memory and CPU:** the whole process: both servers, all 20 simulated clients and the fake AI. The process ran on an x64 Node under Rosetta, which is slower than a native arm64 Node.
- **Redis:** the commands counted are the whole Redis server's. They leave out what real servers add: each heartbeat and the crash-recovery sweep. The harness runs with `sweepMs: 0`, which turns both off.
- **The stop:** each person's connection closed with `transport close` and the script reconnected them to the other server at once, as a load balancer would. A real browser first waits 0.5–1.5 s (socket.io's reconnection delay), so the 139 ms is shorter than a real stop would be.

## What broke, and what was done about it

Nothing.

## What these tests don't show

- **Real internet conditions:** everything ran over localhost, with no latency, jitter or packet loss between the people, the API and the SFU.
- **LiveKit Cloud's limits:** the SFU here was `livekit-server --dev` on the same Mac as the load generator.
- **Real browsers:** neither test runs the web app. lk's synthetic participants never run Zylo's client code, and the load check's clients are socket.io clients in Node.
- **Separate machines:** the two API servers shared one process and one machine. On Railway each replica has its own.
