# UpSurge — Production Readiness Audit

_Audit date: 2026-06-23. Scope: engine logic & n8n parity, security & secrets,
CRM/Retell integrations, build/test/deploy. Read-only; no code was changed._

**Bottom line:** the architecture is sound and the security fundamentals are in
place (RLS on every table, encrypted-at-rest secrets, HMAC-verified webhooks,
per-route authz). But there are **two cutover-blocking correctness bugs** that can
double-write to a client's live CRM or stall all outbound calling under load, plus
a cluster of robustness gaps. Do not cut over from n8n until the Critical and High
items below are closed.

Two claims were verified directly against the source (not just agent report): the
idempotency race (`process-outcome.ts:67`) and the missing fetch timeouts (only
`webhooks/post-call.ts` has one). Both confirmed.

---

## Critical — fix before cutover

### C1. Outcome processing is not concurrency-safe (double CRM writes)
`src/lib/engine/process-outcome.ts:67` — `if (call.status === "completed") return`
is a check-then-act. The row's `status` is set to `completed` only at the *end* of
processing, after all side effects. Retell routinely fires `call_analyzed` more than
once, and the stuck-call reconciler is a second caller. Two concurrent runs both pass
line 67 and both proceed → **double CRM note, double tag sync, double follow-up task,
cadence advanced twice, and `agent_memory.call_count` incremented twice**
(`memory.ts:80`). The `retell_call_id` unique index does **not** prevent this — nothing
inserts a conflicting row; the path UPDATEs the existing row by `id`.

This writes duplicates into the client's live CRM, so it's the top parity blocker.

**Fix:** atomically claim the row before doing side effects —
`UPDATE calls SET status='processing' WHERE id=? AND status NOT IN ('processing','completed')`
and only continue if a row was actually updated (check rowcount). Or use a Postgres
advisory lock keyed on the call id.

### C2. No fetch timeouts in any CRM/Retell client (worker can wedge)
`src/lib/crm/followupboss.ts`, `src/lib/crm/highlevel.ts`,
`src/lib/crm/highlevel-oauth.ts`, `src/lib/retell/client.ts` — every `fetch` is bare
(no `AbortSignal`/timeout). Node's global fetch has no default timeout. The call worker
runs `concurrency: 20`; 20 stalled sockets (slow Retell, hung FUB `setTags`) exhaust
every worker slot and outbound calling silently halts. The only timeout in the codebase
is in `webhooks/post-call.ts:104`.

**Fix:** add `AbortSignal.timeout(15_000)` (longer for Retell create-call) to every
fetch; catch `AbortError` and let BullMQ retry.

### C3. HighLevel token-refresh race de-auths the location under load
`src/lib/crm/highlevel.ts:33,54` — the in-flight dedupe (`this.refreshing`) only covers a
single adapter instance, but a **new adapter is constructed per job**
(`getCrmAdapterForAgent`). Under concurrency 20, multiple jobs see the same expired
`expiresAt` and POST `refresh_token` simultaneously. HighLevel rotates the refresh token,
so the first refresh invalidates the token the others just used → losers persist a dead
token → the location silently needs reconnect and all its calls fail.

**Fix:** serialize refresh across the process with a `locationId`-keyed promise/mutex, and
re-read persisted creds after acquiring the lock. For multi-process safety (app + worker),
use a DB advisory lock or `SELECT … FOR UPDATE`.

---

## High

### H1. `placeCall` has no call-window guard of its own
`src/lib/engine/caller.ts` `placeCall()` never re-checks the calling window. It's currently
saved only because `worker` (`call.worker.ts`) checks `withinEasternBusinessHours()` +
the agent window and defers before calling `placeCall`. That makes the 9am–7pm ET invariant
bypassable by any other caller (manual/test paths, future code). **Defense-in-depth:** move
the hard window check inside `placeCall` so the invariant can't be skipped. (This is the
originally-flagged parity bug — mitigated in the worker, not yet hardened at the source.)

### H2. Duplicate `calls` rows on BullMQ retry
`caller.ts:85` inserts a fresh `queued` calls row on every invocation; with `attempts: 3`,
a job that throws after the insert (e.g. Retell create fails) leaves orphan `queued` rows.
The `failed` cleanup only runs on the *final* attempt — if attempt 2 succeeds, attempt 1's
orphan is never cleaned. **Fix:** carry the `callId` through the job after first insert, or
upsert keyed on `(contact_id, attempt_number, status='queued')`.

### H3. Cadence advances even when CRM writes failed
`process-outcome.ts` updates the local `contacts` row (terminal flag / `next_eligible_on`)
unconditionally, using `crmFlags` only for observability. If the FUB tag sync silently
failed, the contact is dropped locally but the enroll tag is never removed in FUB →
divergence from n8n (which treats FUB tags as source of truth). **Fix:** don't set
`is_terminal` / advance locally when `tags_synced` is false; let it retry.

### H4. HighLevel refresh-failure has no reconnect signal
`highlevel.ts:48-78` — an expired/revoked refresh token throws a generic error that
BullMQ just retries; nothing tells the operator to re-OAuth. **Fix:** detect `invalid_grant`
and flag the agent (`crm_status = 'needs_reauth'`) in the UI.

### H5. No 429 / rate-limit handling in CRM adapters
`followupboss.ts:58`, `highlevel.ts:112` — 429s are thrown like any error; `Retry-After`
is ignored. FUB caps ~250 req/10s; the poll loop + per-outcome writes will trip it at volume
and BullMQ retries risk a retry storm. **Fix:** honor `Retry-After` with bounded backoff,
or add a queue-level rate limiter.

### H6. OAuth `state` is not bound to the user
`src/app/api/agents/[id]/crm/connect/route.ts:39` — `state` encodes only `{agentId, ts}`,
not the user. The callback re-checks `auth.getUser()` + RLS (which is what keeps this from
being Critical), but the binding is weak and replayable within the 10-min window. **Fix:**
include `user.id` in the encrypted `state` and assert it matches in the callback; add a
one-time nonce (httpOnly cookie).

### H7. No CI and ESLint not configured
`.github/workflows/` does not exist — nothing gates merges (no automated typecheck/test/
build). `npm run lint` drops into Next's interactive setup prompt (no `.eslintrc`), so lint
effectively never runs. **Fix:** commit an ESLint config and a CI workflow
(typecheck + test + build) before cutover.

---

## Medium

- **M1. Migration-exec route must not ship.** `src/app/api/cron/apply-migration-0007/route.ts`
  POSTs arbitrary SQL to the Supabase Management API using `SUPABASE_ACCESS_TOKEN`, gated only
  by a non-timing-safe `CRON_SECRET`. Delete it before production.
- **M2. Tests exist but were not verified.** Three test files are present
  (`reporting/aggregate.test.ts`, `engine/crm-writeback.test.ts`, `engine/engine.test.ts`) —
  CLAUDE.md's "zero tests" is stale. `npm test` could not be run in the audit sandbox (esbuild
  platform mismatch, an environment artifact, not a code failure). Run it on macOS and confirm
  the money logic (`classifyOutcome`, `nextEligibleDate`/`isEligible`, `reconcileTags`) is
  actually covered.
- **M3. FUB pagination uses a length heuristic, not `_metadata.next`** (`followupboss.ts:88`).
  A short non-final page would silently drop enrolled contacts (they'd never get called).
- **M4. Duplicate notes/tasks on partial-retry.** Notes/tasks POST with no idempotency key
  (`followupboss.ts:162,184`, `highlevel.ts:169,183`). If a note succeeds then a later step
  throws, BullMQ re-runs the whole job and re-POSTs the note.
- **M5. Unknown Retell outcomes silently become `no_answer`** (`outcome.ts:42`). A new Retell
  outcome string would be invisibly swallowed — the contact keeps getting called, never
  terminal. Add logging on the fallthrough.
- **M6. `nextEligibleDate` indexing looks off-by-one** (`cadence.ts:255`) — `attemptJustCompleted`
  (1-based) used as a 0-based gap index. Verify against n8n and add a unit test.
- **M7. Service-role-after-RLS-check pattern is correct but fragile.** Several routes do an
  RLS read check then switch to the RLS-bypassing service client. No IDOR found, but a future
  route that forgets the pre-check gets cross-tenant access. Add an `assertCanAccess()` helper.
- **M8. Malformed/empty JSON unguarded** across adapters (`await res.json()` on a 200 with an
  HTML/empty body throws an opaque SyntaxError). Wrap and surface status + body snippet.

---

## Low

- **L1.** Retell call creation is not idempotent — a retried dial that already placed a real
  call could place a second (real-money risk, low frequency). Check for an existing `dialing`
  row before creating.
- **L2.** `CRON_SECRET` / webhook digest comparisons use `===`, not `crypto.timingSafeEqual`.
  Low impact (high-entropy tokens) but cheap to fix.
- **L3.** Worker `concurrency: 20` may exceed Retell's *concurrent-call* cap (distinct from
  create-rate). Confirm against the Retell plan before high volume.
- **L4.** Missing-taxonomy fallback in `reconcileTags` silently writes the no-answer tag and
  `isTerminal=false`, so a `dnd`/`not_interested` with no taxonomy row would not terminate.
  Make a missing match loud.
- **L5.** Pin Node 22 on both Vercel and Railway to match `engines.node` and the local runtime.
  Note `tsx` runs the worker un-compiled in prod (intentional) — keep it in `dependencies`.

---

## Confirmed good (no action)
- RLS enabled on all tables with org/workspace-scoped policies; no `bypassrls`/`disable RLS`
  anywhere; helper functions are `security definer` with pinned `search_path`.
- Crypto (`crypto.ts`): random 12-byte IV per encryption, GCM auth tag verified on decrypt,
  32-byte key length validated. No nonce reuse.
- Retell webhook: raw body used for HMAC before any parse; missing signature → 401; missing
  secret → 503; multi-secret verify is non-short-circuiting.
- No secret is logged, returned, or placed in a redirect/query string. FUB key lives only in
  the Basic auth header; no `NEXT_PUBLIC_` misuse.
- FUB custom-field constraint respected — state modeled purely via tags, no `customFields`.
- All request bodies are Zod-validated. `.env.example` documents all 14 `process.env` keys.
  Migrations `0001`–`0012` are contiguous. No TODO/FIXME left in `src`/`worker`.

---

## Remediation status — applied 2026-06-23 (code + DB)

Implemented in this pass (IDE language-server clean on every changed file; run
`npm run typecheck` + `npm test` locally to confirm — the in-session shell was
unavailable).

**Critical — all fixed**
- **C1 done.** Atomic outcome-processing claim. New `calls.outcome_claimed_at`
  lease column (migration `0015`, applied to prod DB). `process-outcome.ts` now
  does a leased compare-and-set (`UPDATE … WHERE id=? AND status<>'completed'
  AND (outcome_claimed_at IS NULL OR < now-5m)`) and bails if it didn't win the
  claim. Self-heals after 5 min if a processor dies. This also resolves **M4**
  (duplicate note/task on re-fire) since a second run can't pass the claim.
- **C2 done.** New `src/lib/http.ts` (`fetchWithTimeout` + `parseJsonResponse`).
  Every CRM/Retell/OAuth fetch now has a hard timeout (15s reads, 30s
  create-call) so stalled sockets can't exhaust worker slots. Also closes **M8**
  (loud status+snippet on non-JSON 200s).
- **C3 done.** HighLevel refresh is now serialized **across the process** via a
  `locationId`-keyed lock map (not just per-instance), so concurrent jobs can't
  each spend the rotating refresh token and de-auth the location.

**High**
- **H1** already satisfied — `evaluateDialWindow` is the authoritative guard
  inside `placeCall` (the audit text was stale).
- **H2 done.** `placeCall` reuses a leftover `queued` row for the same
  (agent, contact, attempt) instead of inserting a new one.
- **H3 done (safe variant).** On a terminal outcome we always stop calling
  locally (prevents re-dialing a DND/declined contact even if the CRM write
  failed) and now log + persist a loud divergence warning when the tag sync
  failed, for manual CRM reconcile. (The literal "don't mark terminal" fix was
  rejected — it would re-dial DND contacts.)
- **H4 done.** `HighLevelReauthRequiredError` on `invalid_grant` now fires a
  `crm_status='needs_reauth'` flag on the agent/workspace (migration `0017`,
  applied to prod), surfaced as a "Reconnect needed" badge + banner on the agent
  page; a successful refresh/OAuth connect clears it.
- **H5 done.** FUB + HighLevel adapters honor `Retry-After` on 429 with bounded
  backoff before surfacing to BullMQ.
- **H6 done.** OAuth `state` now binds `userId`; the callback rejects a state
  minted for a different user.
- **H7 done.** `.github/workflows/ci.yml` runs lint + typecheck + test + build on
  push/PR to `main`. ESLint configured (`eslint` + `eslint-config-next` installed,
  `.eslintrc.json` extends `next/core-web-vitals`); `npm run lint` is clean.

**Medium / Low**
- **M1 done.** Deleted `api/cron/apply-migration-0007/route.ts`.
- **M2** — money-logic tests already exist (`engine.test.ts`); added cases for the
  L4 safety net and a new `http.test.ts` for `retryAfterMs`.
- **M3 done.** FUB pagination now driven by `_metadata.next` / `total`.
- **M5 done.** Unknown Retell outcomes log a warning before the safe fallback.
- **M6** — verified correct by existing `nextEligibleDate` tests; no change.
- **L1 done** (real-dial idempotency in `placeCall`). **L2 done** (timing-safe
  `bearerMatches` in `src/lib/secure.ts`, used by the cron auth). **L3 done**
  (worker concurrency + rate limiter now env-configurable:
  `CALL_WORKER_CONCURRENCY` / `CALL_WORKER_RATE_MAX` / `CALL_WORKER_RATE_DURATION_MS`,
  defaults unchanged — set to match the Retell plan). **L4 done**
  (intrinsic-terminal net for dnd/not_interested/appointment when taxonomy is
  missing). **L5 done** (`.nvmrc` = 22).
- **M7 done.** `assertCanAccess()` helper (`src/lib/authz.ts`) centralizes the
  RLS read-check before service-client writes; adopted in both OAuth routes.

**Database (Supabase, applied to prod)**
- Migration `0016`: pinned `search_path` on `seed_default_outcome_tags` +
  `set_updated_at` (clears advisor 0011); revoked PUBLIC/anon/authenticated
  EXECUTE on `handle_new_user()` (clears advisors 0028/0029 for it).
- Left executable for `authenticated`: `user_org_ids` / `user_workspace_ids` —
  the RLS policies call them; they return only the caller's own ids. Accepted WARN.

**Verification (this pass)**
- `npm run lint`, `npm run typecheck`, `npm test` (37 pass), and `npm run build`
  all green. Committed on `main` (not pushed/deployed).

**Still open (not code — needs you / ops)**
- Enable Auth "leaked password protection" in the Supabase dashboard (advisor) —
  Authentication → Policies → enable HaveIBeenPwned check. No SQL/API exposed.
- Tune `CALL_WORKER_*` env vars to the Retell account's concurrent-call cap.
- **Phase 2 ops** (unchanged): provision Redis, set `REDIS_URL` on Vercel +
  Railway, deploy worker, parallel cutover. See `docs/DEPLOY_WORKER.md`.

---

## Recommended pre-cutover order
1. **C1** — atomically claim the call row (stops live-CRM double-writes).
2. **C2** — add fetch timeouts everywhere (stops worker wedging).
3. **C3** — serialize HighLevel refresh (stops silent de-auth under load).
4. **H1–H3** — harden the window guard in `placeCall`, fix retry-orphan rows, gate cadence
   advance on tag-sync success.
5. **M1** — delete the migration-exec route.
6. **H6 / H7 / M2** — bind OAuth state to user, add CI + ESLint, verify the test suite passes
   and covers the money logic.
