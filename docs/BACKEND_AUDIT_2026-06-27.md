# UpSurge Backend Audit — Outgoing Calls, Autonomy & Scale

_Date: 2026-06-27 · Scope: call-placement path, unattended operation, multi-workspace / unlimited-agent scaling._

## Bottom line

The dial engine is in good shape and materially ahead of the CLAUDE.md snapshot. The call-window bug that snapshot flagged as the #1 risk is fixed and now enforced in four independent layers, outcome processing has a real atomic mutex, and there is a full Postgres-backed failover path (Vercel crons) for when the Railway worker or Redis is down. `tsc --noEmit` is clean.

Nothing here blocks placing calls correctly today. The items below are (a) two narrow double-dial windows worth closing before high volume, and (b) database load/index work needed before you scale agent count into the hundreds. Severity is about volume, not correctness.

---

## What is working well

**Call window can't be violated.** `evaluateDialWindow` is the single source of truth and is checked at four points: the poller pre-filters, the call worker pre-checks, `placeCall` throws `OutsideCallWindowError` *before* writing any row or calling Retell (authoritative backstop), and the Postgres drain re-checks. A late poll, a long drip queue, a clock crossing the boundary, or a manual/script caller all get deferred, not dialed.

**Outcome processing is idempotent and atomic.** `process-outcome.ts` claims each call with a time-leased compare-and-set on `outcome_claimed_at` before any CRM side effect, so Retell's duplicate `call_analyzed` deliveries and the reconciler can't double-write notes/tags/tasks or double-advance cadence.

**Autonomy is genuinely redundant.** Railway worker runs the scheduler + poll/call workers + self-heal sweeps; if its heartbeat goes stale or Redis/Upstash is unhealthy, Vercel crons take over: `drain-queue` places calls straight from Postgres, `poll-fallback` runs the poll without Redis, `reconcile-stuck-calls` finalizes calls whose webhook never landed. The durable `call_queue_entries` table is the source of truth and the sweeper re-aligns Redis to it after a restart. Crash guards, a Redis-pinging health endpoint, and graceful shutdown are all present.

**Tenancy basics are sound.** Per-agent Retell + CRM credentials encrypted at rest; agent→workspace ownership re-checked inside `placeCall`; RLS on tenant tables; call-worker rate limit + concurrency are env-tunable to match Retell caps.

---

## Findings — call placement

### 1. Dial idempotency is read-then-write, not atomic (Medium)
`placeCall` guards against double-dialing by selecting an existing `dialing`/`completed` row for `(agent_id, contact_id, attempt_number)` and bailing if found — but there is **no database unique constraint** backing it. Two `placeCall` runs racing on the same contact (worker + drain during a Redis flap, or a duplicate BullMQ job) can both read "none found" and both create a Retell call → the person is dialed twice and billed twice.

Today this is only *operationally* prevented by the heartbeat gate (drain runs only when the worker looks dead). Make it structural:
- Add a partial unique index, e.g. `unique (agent_id, contact_id, attempt_number) where status in ('dialing','completed')`, and treat the insert conflict as "already dialed"; **or**
- Have the BullMQ worker claim the durable queue row (`claimQueueEntry`, pending→dialing) the same way `drain.ts` already does, so both executors share one mutex.

### 2. Worker and drain don't share a claim (Low–Medium)
Related to #1: `drain.ts` atomically claims the queue row before dialing; the BullMQ worker does not (it calls `markQueueDialing` only *after* Retell accepts). The two paths rely on the heartbeat gate rather than a common lock. Closing #1 via the queue-claim option resolves this too.

### 3. Confirm Retell account caps vs. worker defaults (Low)
`CALL_WORKER_CONCURRENCY` and `CALL_WORKER_RATE_MAX` default to 20. They're env-tunable now (good), but verify them against the actual concurrent-call and create-call rate limits on each Retell account before pushing volume.

### 4. `ensureAgentWebhookUrl` fires on every dial (Low)
Each `placeCall` issues a fire-and-forget `PATCH /update-agent` to bind the webhook. That's an extra Retell API call per dial and a write that races the call creation. Consider doing it once at agent activation instead of per-dial.

---

## Findings — scale (multi-workspace, many agents)

### 5. `poll-fallback` does heavy per-agent queries every minute (High at scale)
The cron runs `*/1`. For **every** active in-window agent it calls `hasMissedDailyPoll`, which fires three COUNT queries — including a `contacts` scan with stacked `.or(...)` filters — *before* deciding the worker is healthy and skipping. So during the call window, DB cost grows linearly with agent count every single minute even when nothing is wrong. With dozens of agents this is sustained load; with hundreds it's a problem. Fix: short-circuit on `!stale && redisOk` before the per-agent work, cache the "missed poll" check, or widen the cron to `*/2`–`*/5`.

### 6. Missing indexes for the hot failover/watchdog queries (High at scale)
`call_queue_entries` has only a `(workspace_id, status, enqueued_at)` partial index, and `calls` has none on `(agent_id, dialed_at)`. But `drainDueDials`, `checkDialStalls`, and `countDialedTodayForAgent` filter/scan by `agent_id` + `status` + `scheduled_for` and by `agent_id` + `dialed_at` on every cron tick. Those become sequential scans as the tables grow. Add:
- `call_queue_entries (agent_id, status, scheduled_for)` (partial `where status = 'pending'`),
- `calls (agent_id, dialed_at)`.

### 7. One global rate limiter / concurrency pool across all tenants (Medium at scale)
The call worker has a single BullMQ limiter and one concurrency pool spanning every workspace and agent. It's *safe* (never exceeds the cap) but not *fair* or *per-account*: a high-volume workspace can head-of-line-block another's dials, and a single global cap can't honor separate per-Retell-account limits when agents run on different Retell keys. For real multi-account scale, move toward per-account queues or BullMQ groups.

### 8. Per-agent N+1 in scheduler/poller (Medium at scale)
`tickScheduler` issues ~2 queries per agent per minute; `pollWorkspace` polls agents sequentially. Fine for tens of agents; batch the config/workspace reads and parallelize before hundreds.

---

## Minor / housekeeping

- **CLAUDE.md is stale.** It states "zero test files" and lists the dial-window re-check as open gap #1 — both are now resolved (13 `*.test.ts` files exist; window re-check is implemented). Refresh it so the next session starts from reality.
- **I could not execute the unit tests in this sandbox** — `esbuild`'s Linux binary is blocked by the registry policy here and the installed copy is macOS. `tsc --noEmit` passes. Run `npm test` locally to confirm green before cutover.

---

## Suggested order before cutover / scaling

1. Close the double-dial window (#1, ideally via the shared queue-claim, which also fixes #2). _Correctness + cost._
2. Add the two indexes (#6) and lighten `poll-fallback` (#5). _Stops DB load from scaling with agent count._
3. Confirm Retell account caps (#3).
4. Revisit per-tenant queue fairness (#7) when you onboard multiple Retell accounts.
5. Refresh CLAUDE.md and run the test suite locally.

---

## Remediation log (2026-06-28)

All findings above were addressed in code/docs except #7 (deferred by design):

| # | Remediation |
| --- | --- |
| 1–2 | BullMQ worker claims `call_queue_entries` before `placeCall`; partial unique index in `0022_backend_audit_indexes.sql` |
| 3 | Documented in [PRODUCTION-READINESS.md](./PRODUCTION-READINESS.md) — tune `CALL_WORKER_*` env |
| 4 | `bindRetellWebhookForAgent` at provision/activation; removed per-dial PATCH |
| 5 | `poll-fallback` returns on healthy heartbeat + Redis; cron widened to `*/2` |
| 6 | Migration `0022_backend_audit_indexes.sql` |
| 7 | Design doc [MULTI-ACCOUNT-FAIRNESS.md](./MULTI-ACCOUNT-FAIRNESS.md) — implement when multi-account |
| 8 | Batched scheduler query; bulk contact upsert; parallel `pollWorkspace` (concurrency 4) |

Run `npm run typecheck` and `npm test` before cutover. Apply migration `0022` before deploy.
