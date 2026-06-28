# Production readiness — dial engine

_Checklist derived from [BACKEND_AUDIT_2026-06-27.md](./BACKEND_AUDIT_2026-06-27.md)._

## Before cutover

1. Apply migration `0022_backend_audit_indexes.sql` in Supabase **before** deploying code that relies on the unique dial guard.
2. Set worker env vars on Railway (or wherever `npm run worker:prod` runs).
3. Run `npm run typecheck` and `npm test` locally.
4. Confirm Retell account limits in the Retell dashboard (concurrent calls + create-call rate).

## Worker env — Retell rate / concurrency

Tune on the **worker** process only. Defaults are safe for a single Retell account at moderate volume.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CALL_WORKER_CONCURRENCY` | `20` | Max simultaneous `placeCall` jobs in the BullMQ worker |
| `CALL_WORKER_RATE_MAX` | `20` | Max Retell `create-phone-call` requests per window |
| `CALL_WORKER_RATE_DURATION_MS` | `1000` | Rate limiter window (ms) |

**Recommended starting point (single Retell account):** leave defaults until you know the plan's concurrent-call cap, then set:

- `CALL_WORKER_CONCURRENCY` ≤ Retell concurrent-call limit (leave 2–3 headroom)
- `CALL_WORKER_RATE_MAX` ≤ Retell create-call rate limit per second

Example for a 15 concurrent / 10 per second account:

```
CALL_WORKER_CONCURRENCY=12
CALL_WORKER_RATE_MAX=10
CALL_WORKER_RATE_DURATION_MS=1000
```

## Failover crons (Vercel)

| Route | Schedule | Notes |
| --- | --- | --- |
| `/api/cron/poll-fallback` | `*/2 * * * *` | Returns immediately when worker heartbeat + Redis are healthy |
| `/api/cron/drain-queue` | `*/1 * * * *` | Postgres drain when worker stall / Redis down |
| `/api/cron/dial-watchdog` | `*/5 * * * *` | Ops alert only |

Requires `CRON_SECRET` on Vercel.

## Audit remediation status (2026-06-28)

| # | Finding | Status |
| --- | --- | --- |
| 1 | Dial idempotency read-then-write | **Fixed** — shared queue claim + partial unique index |
| 2 | Worker/drain don't share claim | **Fixed** — BullMQ worker claims before `placeCall` |
| 3 | Retell caps vs worker defaults | **Documented** — tune env above before high volume |
| 4 | `ensureAgentWebhookUrl` every dial | **Fixed** — bind at provision/activation only |
| 5 | `poll-fallback` heavy per-agent queries | **Fixed** — healthy-path early return; cron `*/2` |
| 6 | Missing hot-path indexes | **Fixed** — migration `0022_backend_audit_indexes.sql` |
| 7 | Global rate limiter / fairness | **Deferred** — see [MULTI-ACCOUNT-FAIRNESS.md](./MULTI-ACCOUNT-FAIRNESS.md) |
| 8 | Scheduler/poller N+1 | **Improved** — batched reads + bounded parallel poll |
