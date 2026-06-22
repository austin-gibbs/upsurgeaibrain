# UpSurge — Agent Context / Catch-Up

Read this first. It captures the *operational context* and *open work* that the
codebase alone doesn't tell you. For app design read `README.md` and
`docs/ARCHITECTURE.md`; for agent-memory design read `docs/V2-MEMORY.md`.

_Last updated: 2026-06-22._

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
  cadence → update V2 memory. Idempotent on `retell_call_id`.
- **Scheduler** (`src/lib/engine/scheduler.ts`) ticks every minute (or external cron) and
  enqueues the daily poll per active agent.
- Pure logic lives in `cadence.ts`, `outcome.ts`, `tags.ts`, `memory.ts`.

## Open items / known gaps (my review, 2026-06-22)

1. **Dial-time call-window gap (highest priority for parity).** `caller.ts placeCall()`
   does NOT re-check the call window. The poller checks it once at poll time, but calls are
   drip-delayed (`i * drip_seconds`). A late poll or a long queue (e.g. 100 calls × 60s ≈
   100 min) can fire dials **after `call_window_end` (7pm)** — the exact bug just patched in
   n8n WF1. Fix: re-check `withinCallWindow(workspace.timezone, ...)` inside `placeCall` and
   skip/no-op (or reschedule to next day) when outside the window.
2. **No tests.** ARCHITECTURE calls the logic "unit-testable," but there are zero test files.
   Before cutover, add unit tests for `classifyOutcome`, `nextEligibleDate`/`isEligible`,
   and `reconcileTags` — these encode the money logic.
3. **Duplicate `calls` rows on retry.** Call queue has `attempts: 3`. `placeCall` inserts a
   fresh `queued` calls row each invocation, so a retried job can leave orphan `queued` rows
   (the worker marks them failed on final failure). Cosmetic, but worth tidying.
4. **Retell concurrency** is bounded only by worker `concurrency: 5` + drip spacing; confirm
   against the Retell account's concurrent-call limit before high volume.
5. **Single initial commit** (`cda3e0b`) — no incremental history yet.

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
parity with the live n8n system as the cutover bar; close the gaps above (start with #1).
