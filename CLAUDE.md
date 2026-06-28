# UpSurge — Agent Context / Catch-Up

Read this first. It captures the *operational context* and *open work* that the
codebase alone doesn't tell you. For app design read `README.md` and
`docs/ARCHITECTURE.md`; for agent-memory design read `docs/V2-MEMORY.md`.

_Last updated: 2026-06-28._

---

## What this project is, in one paragraph

UpSurge runs outbound **AI voice agents** (Retell AI) for client businesses, driven
off their CRM (Follow Up Boss or HighLevel). A contact tagged with the enroll tag gets
called on a cadence; the agent's outcome is classified, written back to the CRM as a
note + tag, and the contact either advances to its next-eligible date or is removed from
the flow (terminal outcomes: **appointment, not_interested, dnd**). This repo is the
**native productized replacement** for a two-workflow n8n system that is still the thing
running in production today.

## Current state of the transition (the important part)

- **n8n is still LIVE in production.** Two workflows on `upsurgepros.app.n8n.cloud`:
  - WF1 "Call Initiator (Poll)" — `https://upsurgepros.app.n8n.cloud/workflow/gMSGie02n5mp2imr`
  - WF2 "Outcome Handler" (Retell `call_analyzed` webhook).
- **This app is "almost ready" to take over** but has NOT cut over yet. Do not assume
  the app is serving live traffic.
- Most recent n8n change (already applied & published): the **calling window** in WF1's
  "Filter Eligible Contacts" code node was set to **Mon–Sun, 9am–7pm America/New_York**,
  with a capacity cap so overflow contacts are never marked and roll to the next 9am run.
- The app reproduces the verified n8n logic as typed code. Behavior parity with n8n is
  the bar for cutover.

## Where everything lives

| Thing | Location |
| --- | --- |
| This repo (source of truth) | `github.com/austin-gibbs/upsurgeaibrain` (remote `origin`, this clone) |
| Local clone (Cursor) | `/Users/austingibbs/Developer/UpSurge` |
| Hosting | Vercel — domain `upsurgeprosai.com` (project deployed; worker runs separately) |
| Voice | Retell AI (`retell-sdk`) |
| DB / Auth | Supabase (Postgres + RLS) |
| Queue | BullMQ + Redis (ioredis) |
| n8n (legacy, live) | `upsurgepros.app.n8n.cloud` — WF1 + WF2 above |

> Note: an earlier public repo `github.com/austin-gibbs/upsurgeaiagentapp` exists with the
> same structure, but **this clone's `origin` is `upsurgeaibrain`** — treat this one as
> the working source of truth. There was also a stale standalone copy under
> `~/Desktop/Business/AI Voice Agents/upsurge-platform/` — do NOT push that; it is
> older/less complete than this repo.

## The two engine loops (quick map)

- **Poller** (`src/lib/engine/poller.ts`) replaces WF1: daily per agent, pull enroll-tagged
  contacts, filter eligible, cap at `max_calls_per_day`, enqueue drip-spaced `dial` jobs.
- **Caller** (`src/lib/engine/caller.ts`) places one Retell call per job.
- **Outcome processor** (`src/lib/engine/process-outcome.ts`) replaces WF2: on the
  `call_analyzed` webhook, classify → CRM note → reconcile tags → optional task → advance
  cadence → update V2 memory. Idempotent via atomic `outcome_claimed_at` claim.
- **Scheduler** (`src/lib/engine/scheduler.ts`) ticks every minute (or external cron) and
  enqueues the daily poll per active agent.
- **Failover** — Vercel crons (`poll-fallback`, `drain-queue`, `dial-watchdog`) take over
  when the Railway worker heartbeat is stale or Redis is down. Durable `call_queue_entries`
  is the source of truth.
- Pure logic lives in `cadence.ts`, `outcome.ts`, `tags.ts`, `memory.ts`.

## Backend audit status (2026-06-28)

Remediation from [docs/BACKEND_AUDIT_2026-06-27.md](docs/BACKEND_AUDIT_2026-06-27.md) is
**largely complete**. See [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md).

**Resolved since 2026-06-22 snapshot:**

- Dial-time call-window re-check in `placeCall` (throws `OutsideCallWindowError` before any
  Retell call or `calls` row).
- Unit tests exist under `src/lib/**/*.test.ts` (cadence, outcome, tags, drain, watchdog, etc.).
- Shared queue claim in the BullMQ call worker + partial unique index on active call attempts.
- `poll-fallback` healthy-path early return; hot-path DB indexes (migration `0022`).
- Retell agent webhook bound at provision/activation, not per dial.

**Still open before high-volume cutover:**

1. Apply migration `0022_backend_audit_indexes.sql` in prod Supabase.
2. Tune `CALL_WORKER_CONCURRENCY` / `CALL_WORKER_RATE_MAX` to your Retell plan (see production
   readiness doc).
3. Per-Retell-account dial fairness deferred until multi-account scale — see
   [docs/MULTI-ACCOUNT-FAIRNESS.md](docs/MULTI-ACCOUNT-FAIRNESS.md).

## Open items / known gaps (legacy list — see audit status above)

_The items below were accurate on 2026-06-22; several are now resolved. Prefer the
**Backend audit status** section above._

1. ~~**Dial-time call-window gap.**~~ **Fixed** — authoritative guard in `placeCall`.
2. ~~**No tests.**~~ **Fixed** — multiple `*.test.ts` files; run `npm test`.
3. **Duplicate `calls` rows on retry.** Partially improved (reuse orphan `queued` row + unique
   index); cosmetic orphans may still exist on edge retries.
4. **Retell concurrency** — env-tunable (`CALL_WORKER_*`); confirm against Retell plan caps.
5. ~~**Single initial commit.**~~ Repo now has incremental history.

## Hard constraints / rules (do not violate)

- **Never expose or extract the Follow Up Boss API key / Authorization secret.** It lives in
  CRM credentials (encrypted at rest via `src/lib/crypto.ts`, AES-256-GCM). When reading n8n
  workflow JSON, mask secrets.
- **Austin is NOT the FUB account owner**, so **no custom fields** are available — contact
  state is modeled with **tags** (mirrored in the `contacts` table), not custom fields.
- **Do not place real outbound calls** beyond explicitly agreed testing.
- **Any temporary time-gate / safety removal in n8n must be restored before client handoff.**
- `.env.local` holds real secrets and is gitignored — keep it that way; never commit it.

## How to work in this repo

- `npm run dev` (Next.js UI/API) + `npm run worker` (BullMQ workers + scheduler) — two
  processes. `npm run typecheck` to validate. Migrations in `supabase/migrations/` applied
  in order (0001 schema, 0002 RLS, 0003 defaults/helpers).
- Retell webhook target: `{NEXT_PUBLIC_APP_URL}/api/webhooks/retell` (HMAC-verified).
- Adding a CRM = implement `CrmAdapter` (`src/lib/crm/types.ts`), register in
  `src/lib/crm/index.ts`, extend the `crm_provider` enum + Zod union. Engine doesn't change.

## What Austin wants next

Continue enhancing and reviewing this app to finish the transition off n8n. Keep behavior
parity with the live n8n system as the cutover bar. Before go-live: apply migration `0022`,
run `npm test`, tune worker Retell caps, and verify failover crons in staging.
