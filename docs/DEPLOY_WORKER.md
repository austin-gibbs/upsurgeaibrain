# Running the UpSurge engine 24/7 (no laptop required)

The app is two processes:

- **Next.js app** (UI, API, Retell webhook) — already runs 24/7 on **Vercel**.
- **Worker** (`worker/index.ts`: poll + call workers, scheduler, reconcile, queue
  self-heal) — this is what must move **off your laptop** to a always-on host.

Both share one **Supabase** Postgres and one **Redis** (BullMQ). When the worker is
not running, the daily poll never fires and queued dials never place — even though
Retell webhooks on Vercel still finalize in-flight calls.

This guide deploys the worker to **Railway** with a hosted Redis. Render/Fly.io work
the same way (use a Background Worker / Machine with start command `npm run worker:prod`).

---

## What does NOT change

- Agent call windows, cadences, drip spacing, enroll tags (all per-agent/workspace in DB)
- The Retell webhook URL (stays on Vercel)
- CRM credentials, workspace config, agent status
- Outbound calls still only fire inside each agent's configured window

---

## Step 1 — Provision hosted Redis

Pick one:

- **Upstash** (serverless Redis): create a database, copy the `rediss://` URL. Enable
  eviction = `noeviction` and persistence if offered.
- **Railway Redis**: add a Redis plugin/service in your Railway project; copy its
  connection URL (private networking is IPv6 — already handled, see `family: 0` in
  `src/lib/queue/connection.ts`).

Note the connection string as `REDIS_URL`.

> Persistence matters: if Redis restarts and loses the delayed-dial set, the worker's
> 90s queue self-heal sweep re-enqueues from `call_queue_entries` (Postgres). Prefer a
> persistent Redis so this is a rare fallback, not the norm.

## Step 2 — Point Vercel at the same Redis

In Vercel → project `upsurgeaiagentapp` → Settings → Environment Variables (Production):

- Set `REDIS_URL` to the value from Step 1.
- Ensure `CRON_SECRET` is set (used by the backup cron in Step 5).

Redeploy. Verify with:

```
curl https://upsurgeprosai.com/api/health/engine
# -> {"ok":true,"redis":"up"}
```

## Step 3 — Create the Railway worker service

1. Railway → New Project (or existing) → **Deploy from GitHub repo** → `austin-gibbs/upsurgeaibrain`.
2. Railway reads `railway.toml`:
   - Start command: `npm run worker:prod`
   - Health check path: `/health`
   - Restart on failure
3. Set Node to 22.x if prompted (matches `package.json` `engines`).

## Step 4 — Add worker env vars

Copy these from `.env.local` into Railway → Variables (server-only values; never the
browser anon-only set). All are documented in `.env.example`.

| Variable | Required | Notes |
|----------|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | engine bypasses RLS |
| `REDIS_URL` | yes | **same instance as Vercel** |
| `RETELL_API_KEY` | yes | places calls |
| `CREDENTIALS_ENCRYPTION_KEY` | yes | must equal Vercel's or CRM creds won't decrypt |
| `ANTHROPIC_API_KEY` | recommended | agent memory extraction |
| `HIGHLEVEL_CLIENT_ID` / `HIGHLEVEL_CLIENT_SECRET` | if any HighLevel agents | OAuth refresh |
| `NEXT_PUBLIC_APP_URL` | yes | set to `https://upsurgeprosai.com` |
| `NODE_ENV` | yes | `production` (enables the REDIS_URL startup guard) |
| `DISABLE_INTERNAL_SCHEDULER` | no | leave unset/`false` so the worker runs its own scheduler. External `/api/cron/daily-poll` remains a safe backup. Legacy `USE_EXTERNAL_CRON` no longer disables the internal loop. |

`RETELL_WEBHOOK_SECRET` and `CRON_SECRET` are only needed on Vercel, not the worker.

## Step 5 — (Optional) Vercel Cron as a backup scheduler

`vercel.json` adds an every-minute cron hitting `/api/cron/daily-poll`. This is a
**redundant** trigger for the daily poll; it does NOT replace the worker (the poll and
call workers still must run to consume jobs). It's idempotent with the worker's internal
scheduler (duplicate poll jobIds are ignored). Requires `CRON_SECRET` on Vercel.

If you prefer a single scheduler (Vercel cron only), set `DISABLE_INTERNAL_SCHEDULER=true` on the
worker and rely solely on `/api/cron/daily-poll` — but the default (worker scheduler on, cron as
backup) is the most resilient. Legacy `USE_EXTERNAL_CRON=true` is ignored for disabling the
internal loop.

## Step 6 — Safe cutover (run both, then stop local)

1. Deploy the Railway service. Watch logs for:
   ```
   [worker] health server on :8080/health
   [worker] ready. Poll + call workers online.
   ```
2. Confirm `GET /health` on the Railway URL returns `{"ok":true}`.
3. Leave your **local** `npm run worker` running in parallel for one cycle — BullMQ
   supports multiple consumers safely; the scheduler is idempotent.
4. Wait for a scheduler tick at an agent's `daily_run_at` (Nil Patel Probate = 14:00 ET).
   Confirm `[scheduler] enqueued polls:` appears in the **Railway** logs.
5. Confirm dials complete: check the `calls` table / Retell dashboard.
6. **Stop the local worker.** Close the laptop. Confirm Railway logs keep ticking every
   60s and calls still place.

## Step 7 — Monitoring

- Railway health check (`/health`) auto-restarts a dead worker.
- Add an uptime monitor (e.g. Better Uptime / UptimeRobot) hitting the Railway
  `/health` URL and `https://upsurgeprosai.com/api/health/engine`.
- Daily sanity check: each active outbound agent should get one poll job per day at its
  `daily_run_at`. Spot-check the `calls` table for new rows in the expected window.

---

## Rollback

If anything misbehaves, restart `npm run worker` locally — it consumes the same Redis
and immediately resumes the engine. Removing the Railway service does not touch data;
all state lives in Supabase + Redis.
