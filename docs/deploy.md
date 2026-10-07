# Deploying Zylo

The web app runs on Vercel; the API, with its Postgres and Redis, on Railway; video on LiveKit Cloud; sign-in on Clerk. Plan on about an hour the first time. You create the accounts and paste the keys into the dashboards below; nothing else needs them.

## 1. Before you start

- Every phase is merged into `main`. Deploy from `main`.
- Accounts at [Vercel](https://vercel.com), [Railway](https://railway.com) and [LiveKit Cloud](https://cloud.livekit.io).
- The Clerk application you use locally ("Zylo"), with Email and Google sign-in.
- For Zylo AI (Ask AI and nudges): an OpenAI-compatible key, as in `server/.env.example` (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`). Without one, Zylo runs with AI off.

## 2. LiveKit Cloud

1. Create a project.
2. In the project's settings, create an API key. Copy three values: the project URL (`wss://<project>.livekit.cloud`), the API key, and its secret (shown once).

## 3. Railway: the API, Postgres and Redis

1. **New Project → Deploy from GitHub repo**, and pick this repository. Railway starts a first build of the repository root at once. It fails, because the API lives in `server/`. That is expected: sub-step 2 fixes it.
2. In the new service's settings (Railway stages these changes; they take effect when you click **Deploy** in sub-step 5 below):
   - **Root Directory**: `server`. Railway's builder installs the dependencies and runs `npm start` (`node server.js`). It reads Node from `engines` (`>=22`); the `RAILPACK_NODE_VERSION` variable below pins it to 22.
   - **Healthcheck Path**: `/health`.
   - **Networking → Generate Domain**. Note the URL, `https://<api>.up.railway.app`: this guide calls it the API domain.
3. **+ New → Database**: add **PostgreSQL**, then **Redis**.
4. On the API service, under **Variables**, open the Raw Editor and paste these lines, replacing each `<…>`:

   ```
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   REDIS_URL=${{Redis.REDIS_URL}}
   CLERK_PUBLISHABLE_KEY=<Clerk → API keys: the publishable key>
   CLERK_SECRET_KEY=<Clerk → API keys: the secret key>
   LIVEKIT_URL=<the LiveKit project URL, wss://…livekit.cloud>
   LIVEKIT_API_KEY=<the LiveKit API key>
   LIVEKIT_API_SECRET=<the LiveKit API secret>
   AI_BASE_URL=https://api.x.ai/v1
   AI_API_KEY=<your AI key>
   AI_MODEL=grok-4.3
   TRUST_PROXY=1
   RAILPACK_NODE_VERSION=22
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15
   ```

   No AI key? Leave out the three `AI_*` lines.

   - `NODE_ENV=production` turns the logs into JSON lines, one per entry.
   - `TRUST_PROXY=1`: Railway's proxy is one hop in front of the server, so the rate limits see each person's own address.
   - `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`: on a redeploy, Railway sends the old deployment SIGTERM, then SIGKILL after this many seconds. Zylo's planned stop took under 1 s in our load test and is never more than 10, so 15 always lets it finish.
   - Leave out `PORT`: Railway sets it.
   - `CLIENT_ORIGIN` comes in section 5, once the web app has its URL.
5. Railway shows the staged changes (the Root Directory, the healthcheck and the variables): click **Deploy**. The tables are created on start (`db/schema.sql`). The deploy log shows a line with `"msg":"Zylo API listening"` and `"ai":true,"redis":true,"livekit":true` (`"ai":false` if you left the AI lines out).
6. Check the API: `curl -s https://<api>.up.railway.app/health` should show `"db":true`, `"redis":true` and `"livekit":true`. The "listening" line only shows what is *configured*; `/health` shows what the API can actually reach.

If the log says `Redis unavailable (getaddrinfo ENOTFOUND redis.railway.internal)`, the environment's private network is IPv6-only, as in older Railway environments. Set `REDIS_URL=${{Redis.REDIS_URL}}?family=0`.

## 4. Vercel: the web app

1. **Add New → Project**, import this repository, and set **Root Directory** to `web` (Next.js is detected). Vercel reads the Node version from `engines` (`22.x`) in `web/package.json`, so there is nothing to set.
2. **Environment Variables**:

   ```
   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<the same publishable key as on Railway>
   CLERK_SECRET_KEY=<the same secret key as on Railway>
   NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
   NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
   NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
   NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
   NEXT_PUBLIC_SERVER_URL=<the API domain: https://<api>.up.railway.app, no trailing slash>
   ```

   Optional: `NEXT_PUBLIC_MYMEMORY_EMAIL`, an email address that gives Translator Convo's MyMemory fallback a larger free daily quota.
3. Deploy, and note the production URL, `https://<project>.vercel.app`.

`NEXT_PUBLIC_*` values are built into the app: after changing one, redeploy.

## 5. Connect the two

On Railway, add `CLIENT_ORIGIN=https://<project>.vercel.app` to the API service. Use the exact production URL, with `https://` and no trailing slash. It is the only origin the API accepts (CORS, Socket.IO and Clerk's authorized party), so Vercel's preview URLs won't connect. Railway stages the change: click **Deploy** on the staged changes. The API doesn't pick up `CLIENT_ORIGIN` until it has redeployed.

## 6. LiveKit webhook

In the LiveKit Cloud project's settings, open the webhooks and choose **Create new webhook**. Give it a **Name** (anything, such as `zylo-api`). URL: `https://<api>.up.railway.app/livekit/webhook`. Sign it with the same API key as `LIVEKIT_API_KEY`. The API uses it to remove anyone who joins the video room without holding a seat.

Test it: **Actions → Send a test event**. A 200 is good. If the API's Railway logs show `livekit webhook rejected` (a 401), the webhook is signed with the wrong key.

## 7. Clerk

- **Development keys** (the ones you use locally) are enough for a demo. Sign-in works on the Vercel URL, with Clerk's "Development mode" badge and development usage limits.
- **A production instance** needs a domain you own:
  1. In Clerk, create the production instance and add the DNS records it lists.
  2. Set up Google sign-in with your own OAuth credentials from Google Cloud; Clerk's setup page walks through this.
  3. Put the production keys (`pk_live_…`, `sk_live_…`) in place of the development ones, in Vercel (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) and in Railway (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`).
  4. In the Vercel project, add the domain under **Domains**, then point its DNS at Vercel as Vercel says. Set `CLIENT_ORIGIN` on Railway to the domain and click **Deploy** on the staged change (the API doesn't pick it up until it redeploys). In Vercel, redeploy so the new keys are built in.

## 8. Check

1. `curl -s https://<api>.up.railway.app/health` prints `{"ok":true,"db":true,"livekit":true,"redis":true,"ai":true}` (`"ai":false` if you left the AI lines out).
2. Sign in on a computer and start a ZyloCall. Join it from a phone on mobile data, with Wi-Fi off. You see and hear each other both ways.
3. ZyloChat: a line from each side reaches the other.
4. Ask AI: a question gets a streamed answer on both devices.
5. The host turns **AI nudges** on in People, then someone types "I’m stuck". A captioned Zylo AI nudge appears.
6. **A redeploy mid-call:** in Railway, open **Deployments** and **Redeploy** the active deployment while both devices are in the call.
   - Video and audio carry on, and chat works again within a few seconds.
   - Nobody lands in the lobby.
   - The old deployment's log ends with `shutting down` … `shutdown complete`.
7. In the computer's DevTools → Network, the API connection is one WebSocket, with no `transport=polling` requests.

Logs: on Railway, open the API service's **Logs**. Each line is one JSON object; search for `"level":"error"` or for a meeting's code.

## 9. More than one API replica

Supported: Socket.IO runs WebSocket-only, so no sticky sessions are needed. Every server keeps live room state in Redis and sweeps up after a crashed one. Set **Replicas** in the service's settings, and start with one.

## 10. Costs and rollback

**Costs:**
- Vercel Hobby: free.
- Railway: about $5 a month for the API, Postgres and Redis together.
- LiveKit Cloud: the free tier.
- The AI provider: pay per use. Only Ask AI and nudges call it, and both are rate-limited.

**Rollback:**
- Railway: open **Deployments** and use the **Rollback** action on the previous deployment. How far back you can go depends on your plan's deployment retention.
- Vercel: **Instant Rollback**. On the project's Production Deployment tile, click **Instant Rollback**; or, on **Deployments**, open the ⋮ menu on the row, pick the previous deployment, and click **Confirm Rollback**.
  - Hobby can only roll back to the immediately previous deployment.
  - After a rollback, new pushes don't go live until you click **Undo Rollback**.
  - Environment variables are not rolled back.

A Railway rollback replaces the running deployment the way a redeploy does, so a call in progress survives it, as in step 8.6. The schema only ever adds tables and columns (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), so an older API runs fine on a newer database.
