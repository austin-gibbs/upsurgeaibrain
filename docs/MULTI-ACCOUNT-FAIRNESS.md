# Multi-account dial fairness (deferred)

_Context: backend audit finding #7 — one global BullMQ limiter spans all workspaces._

## Current behavior (cutover-safe)

- Single `outbound-call` queue on Redis.
- One call worker with global `concurrency` + `limiter` (`CALL_WORKER_*` env vars).
- **Safe:** never exceeds the configured cap platform-wide.
- **Not fair:** a high-volume workspace can head-of-line-block another tenant's dials.
- **Not per-account:** agents on different Retell API keys share one cap even though Retell enforces limits per account.

This is acceptable for cutover with one primary Retell account and moderate agent count.

## When to implement

Trigger when **any** of these become true:

- Two or more Retell accounts with agents dialing concurrently.
- A single workspace routinely fills the global concurrency pool and other tenants report delayed dials.
- Retell rate-limit errors appear despite env tuning.

## Recommended design (future)

### Option A — BullMQ groups (preferred)

1. Add a non-secret `retell_account_key` on agents (hash of API key or explicit account id).
2. Enqueue dial jobs with BullMQ **groups** keyed by `retell_account_key`.
3. Run one worker (or limiter) per group, each with that account's Retell caps.

Pros: fair within account, honors per-account Retell limits, single Redis instance.

### Option B — Queue per Retell account

1. `outbound-call:<accountKey>` queues.
2. Worker fleet registers consumers per queue with account-specific limiters.

Pros: hard isolation. Cons: more worker wiring, queue sweeper must fan out.

### Option C — Round-robin deferral (lightweight interim)

Before `placeCall`, pick the next workspace/agent with pending jobs using a Redis cursor. Does not fix per-Retell caps but reduces tenant starvation.

## Migration path

1. Ship cutover with global limiter (current).
2. Add `retell_account_key` column + backfill from encrypted credentials.
3. Introduce groups or per-account queues behind a feature flag.
4. Split `CALL_WORKER_*` into per-account env or a DB table of limits.

No code change required until multi-account volume demands it.
