# UpSurge — Pre-Launch Code Review

_Reviewed 2026-06-22, ahead of the morning cutover off n8n. Scope: `src/lib/engine`, API routes + webhooks, CRM adapters, worker, `supabase/migrations`._

## Verdict

The core engine is sound and faithfully reproduces the n8n logic in typed code. **You are close, but do not flip the switch until the three CRITICAL items below are verified** — each one is a "the app looks up but silently does nothing" failure mode that won't surface until a real call comes back.

Good news on the item your `CLAUDE.md` flagged as the #1 blocker: **the dial-time call-window gap is already closed.** `call.worker.ts` re-checks both `withinEasternBusinessHours()` and the per-agent window before every `placeCall`, and defers out-of-window jobs to the next open. The note in `CLAUDE.md` is stale — no calls will fire after 7pm ET from the queue path.

---

## What I fixed in this pass

1. **Poller dropped the contact email** (`src/lib/engine/poller.ts`). The upsert built every field except `email`, so `contacts.email` and the report's `contact_email` were always null. Added `email: c.email`.
2. **Scheduler could miss a day's poll** (`src/lib/engine/scheduler.ts`). It only fired on an *exact* minute match (`now === daily_run_at`). A single skipped tick — worker restart, GC pause, cron jitter at 09:00 — meant that agent never polled that day and placed zero calls. Changed to fire on the first tick **at or after** `daily_run_at`, made idempotent with a `getJob` guard on the per-day jobId so the rest of the day stays a no-op. This is a real reliability win for "fully automated."
3. **Added unit tests for the money logic** (`src/lib/engine/engine.test.ts`) — 17 tests over `classifyOutcome`, `isEligible`, `nextEligibleDate`, and `reconcileTags`, the functions that decide who gets called, when they leave the flow, and what gets written to the CRM. All pass. (Closes `CLAUDE.md` gap #2. Note: `npm run test` needs its native esbuild binary, which only exists on your Mac, not in the review sandbox — run it locally to confirm.)

`tsc --noEmit` is clean after these changes.

---

## CRITICAL — verify before cutover

**C1. Webhook secret must be set, or every outcome is silently dropped.**
`verifyRetellSignature` returns `false` when no secret is configured (per-agent *or* `RETELL_WEBHOOK_SECRET`), so the webhook 401s on every event. Result: calls dial, but `call_analyzed` is rejected → no CRM note, no tag, no cadence advance, contacts stuck dialing until the attempt cap. Confirm `RETELL_WEBHOOK_SECRET` is set in **both** the app and worker envs and matches the Retell dashboard, then fire a test webhook and watch for a 200.

**C2. All migrations must be applied to the production DB.**
The code references columns from 0004–0008 (`agents.direction`, `agents.retell_credentials_encrypted`, `contacts.email`, `calls.contact_name/contact_email/direction`, `workspaces.crm_account_url`, `agent_task_configs.post_call_webhook_*`). The presence of a one-off `/api/cron/apply-migration-0007` route and the last commit ("Fix workspace not found when migration 0007 is not yet applied") suggest schema drift between local and prod. Run `npm run db:verify-schema` against prod and apply anything pending **before** traffic.

**C3. The encryption key must be identical and stable across app + worker.**
CRM and Retell credentials are AES-256-GCM encrypted at rest (`src/lib/crypto.ts`). If the key used to decrypt at runtime differs from the one used to encrypt at provision time, every CRM/Retell call throws. Confirm the key env var is set to the same value in the app process and the worker process. Round-trip a CRM `verifyCredentials` after deploy.

---

## HIGH

**H1. "Test Run" places real calls and bypasses the hard time-gate.**
`testMode` skips the per-agent window *and* the 9am–7pm ET guard (`poller.ts` + `call.worker.ts`), and `placeCall` still dials for real. Clicking the run button at night will call real leads outside legal hours — a direct violation of the "never dial outside hours" hard constraint. Recommend one of: (a) rename the control to "Run now — places real calls," (b) keep the ET guard enforced even in test mode, or (c) add a true dry-run that logs intended dials without calling Retell.

**H2. A webhook that fails mid-processing creates duplicate notes/tasks.**
The idempotency guard (`call.status === "completed"`) is only checked at the top. If processing throws *after* `logCall`/`setTags`/`createTask` but *before* the final status update, Retell retries and re-runs those side effects → duplicate CRM notes, duplicate tasks, repeated tag writes. Harden by claiming the call (set a `processing`/`completed` marker) before external side effects, or make task creation idempotent on `(call_id, assignee)`.

**H3. HighLevel access tokens expire — no refresh logic.**
The adapter stores a static `accessToken`. HighLevel/LeadConnector marketplace tokens expire (~24h) and require refresh-token rotation, which doesn't exist here. Any HighLevel workspace will break within a day. Follow Up Boss (your first client) uses a non-expiring API key and is unaffected — but **do not onboard a HighLevel client until token refresh is implemented.**

**H4. Large uncommitted working tree + thin history.**
A substantial amount of work is unstaged (inbound processor, post-call webhooks, cadence editor, migration 0008, validation, type changes). Shipping unversioned code with no tagged release means no clean rollback if the cutover misbehaves. Commit, push to `origin` (`upsurgeaibrain`), and tag a release before you deploy.

---

## MEDIUM

**M1. Inbound follow-up assignees are hardcoded** to `["Nil", "Jori"]` (`process-inbound.ts`). Fine for the first client, but every workspace's inbound calls will route to those two names. Make it per-agent config before a second client.

**M2. Tag writes are full-array replacements off a cached list.** `setTags` (FUB + HighLevel) overwrites the contact's entire tag set from the tags we cached at poll time. Any tag a human adds in the CRM between poll and writeback is silently wiped. This matches n8n behavior, but consider re-fetching tags immediately before `setTags`, or moving to add/remove deltas.

**M3. Duplicate `calls` rows on retry** (`CLAUDE.md` #3). `placeCall` inserts a fresh `queued` row each attempt; the worker's failed-handler then marks **all** `queued` rows for that contact failed, which can touch rows from other days. Cosmetic, but it muddies reporting.

**M4. Provisioning is not transactional** (`api/workspaces/route.ts`). A failure partway through agent creation leaves an orphan workspace with no rollback. Wrap in a DB function/transaction or add cleanup-on-failure.

**M5. HighLevel phones aren't normalized to E.164** (FUB's are, via `toE164`). Malformed numbers could reach Retell. Route HighLevel phones through the same normalizer.

**M6. Confirm Retell concurrency ceiling** (`CLAUDE.md` #4). The worker caps at 20 dials/sec and concurrency 20; verify that against your Retell plan's *concurrent-call* limit (a different ceiling than rate) before high volume.

**M7. Poll queue grows unbounded.** `getPollQueue()` sets no `removeOnComplete`, so completed poll jobs accumulate (one per agent per day). Add a retention cap.

---

## LOW / polish

- **L1.** Unknown outcome strings classify to `no_answer`, so a novel Retell outcome keeps a contact dialing until the cap. Acceptable, but log/alert on unmapped outcomes so you notice prompt drift.
- **L2.** The `agents_workspace_enroll_tag_idx` unique index blocks two agents in one workspace from sharing an explicit enroll tag (nulls are fine). Edge case to keep in mind.
- **L3.** The webhook returns 422 for benign "no matching call row," which makes Retell retry. Consider 200-with-reason for known non-actionable events to cut retry noise.
- **L4.** Failures only hit `console`. No structured logging or alerting — see the roadmap.

---

## Pre-launch checklist

- [ ] `RETELL_WEBHOOK_SECRET` set in app **and** worker, matches Retell dashboard; test webhook returns 200 (C1)
- [ ] `npm run db:verify-schema` clean against prod; all migrations applied (C2)
- [ ] Encryption key identical in app + worker; CRM `verify` round-trips (C3)
- [ ] Worker running on Railway with the internal scheduler **or** Vercel cron → `/api/cron/daily-poll` with `CRON_SECRET` (one, not both)
- [ ] Retell `from_number`, `agent_id`, and concurrency cap confirmed
- [ ] Code committed, pushed, and tagged for rollback (H4)
- [ ] Smoke test: one test contact → real call → confirm note + tag + task + cadence advance end to end
- [ ] Any temporary time-gate/safety removals in the live n8n restored (hard constraint)
- [ ] Decide the cutover style: hard switch, or run app + n8n in parallel for a day and diff outcomes
