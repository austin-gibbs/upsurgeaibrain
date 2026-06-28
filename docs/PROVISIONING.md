# Provisioning a Retell agent end-to-end (Claude/Cowork flow)

Stand up a working voice agent from a short brief + the client's Retell API key,
with zero trips into the app UI: author the agent in Retell, wire it into UpSurge
(workspace + agent + call/task config + timeframe), and activate it.

This doc is the playbook Claude follows. The user always provides two things —
**agent direction** (inbound/outbound) and **that client's Retell API key** — and
Claude gathers everything else.

## Two scenarios (both supported by the same spec)

The agent is always created **fresh in Retell** regardless of scenario — what
changes is whether the Retell account, the phone number, and the UpSurge workspace
are new or reused.

1. **New client (new Retell account + new UpSurge workspace).** The common case.
   Use a brand-new client Retell API key, `workspace.mode: "new"` (with
   `organizationName` or `organizationId`, plus `ownerEmail`), and usually
   `retell.phone.mode: "provision"` to buy a number.

2. **New agent in an EXISTING Retell account + EXISTING UpSurge workspace.** Adding
   another agent for a client you already run. Pass that client's existing Retell
   API key, set `workspace.mode: "existing"` with the workspace `id`, and either
   `retell.phone.mode: "existing"` (reuse a number already in their Retell account)
   or `"provision"` (buy another). `ownerEmail` is ignored for existing workspaces
   (membership already exists). In multi-agent workspaces the new agent **must** have
   its own `agent.enrollTag` distinct from peers, or activation is blocked.

Mixed cases work too (e.g. existing Retell account but new workspace) — set each
axis independently.

## Architecture

All the heavy lifting lives in one function, `provisionRetellAgent`
(`src/lib/provisioning/provision-agent.ts`). Drive it one of two ways:

- **Script (default, no deploy needed):** `npm run provision:agent -- --spec=<file>`
  runs the orchestration on this machine, talking directly to Retell + Supabase
  using `.env.local`.
- **Admin endpoint (deployed path):** `POST {NEXT_PUBLIC_APP_URL}/api/admin/provision-agent`
  with header `Authorization: Bearer $PROVISION_API_KEY` and the spec as the JSON
  body.

Both validate the SAME Zod spec (`provisionRetellAgentSchema`) and run the SAME
activation invariants (`validateAgentActivation`) the UI uses. The Retell agent is
created with a fixed post-call analysis `call_outcome` enum whose choices match the
classifier's ALIAS map (`RETELL_OUTCOME_CHOICES`), so outcomes classify correctly.

## The spec

See `scripts/provision-agent.example.json` for a fillable template. Key fields:

| Field | Notes |
| --- | --- |
| `direction` | `"outbound"` (dials enrolled contacts on a cadence) or `"inbound"`. |
| `activate` | `true` (default) flips the agent to active after wiring. |
| `retell.apiKey` | **The client's** Retell API key (each client has its own). |
| `retell.responseEngine` | `{ "type": "retell-llm" }` (default — Claude drafts the prompt) or `{ "type": "conversation-flow", "conversationFlowId": "..." }` for a flow built in Retell's UI. |
| `retell.generalPrompt` | Required for `retell-llm`. Drafted from the brief. |
| `retell.phone` | `{ "mode": "provision", "areaCode": 470 }` to buy a number, `{ "mode": "existing", "number": "+1..." }` to reuse, or `{ "mode": "none" }`. |
| `ownerEmail` | Email of the app user who should own/see the workspace. **Required for new workspaces** — without it, Supabase RLS hides the workspace in the app (the provisioner links the user via `organization_members` + `created_by`). The user must have signed into the app at least once. Ignored for existing workspaces. |
| `workspace` | `{ "mode": "existing", "id": "<uuid>" }` or `{ "mode": "new", ... }`. New workspaces take `organizationId` **or** `organizationName` (found-or-created by name), and `crmProvider` (defaults `followupboss`). |
| `workspace.crmCredentials` | **Optional for new workspaces.** Omit to defer CRM — the agent is still provisioned but lands as `draft` until CRM is connected in the app. Include to activate immediately. |
| `agent.callConfig` | Call window = the timeframe, plus cadence + caps. Missing keys default. For a fixed daily call, set `cadence_day_gaps: [1]` + `max_attempts_per_contact: <days>`, with a tight `call_window_start`/`end` bracketing `daily_run_at`. |

## Steps

1. **Confirm direction + the client's Retell API key.** Ask if either is missing.
2. **Gather the rest with `AskUserQuestion`** (workspace target, phone handling,
   conversation model, timeframe/cadence, enrollment tag). Offer the UpSurge
   defaults (call window 09:00–18:00, 100 calls/day, 10 attempts, cadence
   `[0,1,2,3,5,7,10,14,21,30]`) as the recommended option.
3. **Draft the agent prompt from a brief** (business, objective, tone). Write
   `retell.generalPrompt` + `retell.beginMessage`, steering the call toward exactly
   one outcome the classifier understands: `appointment`, `not_interested`, `dnd`,
   `interested_no_appointment`, `follow_up`, `no_answer_voicemail`. **Show the draft
   to the user for approval before provisioning.** (Claude need not add the analysis
   field — the provisioner attaches it automatically.)
4. **Write the spec JSON** to a temp file, then **dry-run it**:
   `npm run provision:agent -- --spec=./provision-<client>.json --dry-run`.
5. **Provision for real:** `npm run provision:agent -- --spec=./provision-<client>.json`.
   Output: `retellAgentId`, `fromNumber`, `workspaceId`, `agentId`, `status`. The
   user wants immediate activation, so keep `activate: true`. If activation is
   blocked, the agent is left `draft` and the reason is printed — relay and fix.
6. **Report the created IDs + status**, then delete the temp spec (it holds the
   Retell API key).

## Post-provision: activate + enroll (helper scripts)

When CRM was deferred (`workspace.crmCredentials` omitted), the agent lands `draft`.
After the user connects CRM in the app, finish the wiring with these scripts (all
read `.env.local`, all keyed by workspace **name**, all idempotent):

- `npx tsx scripts/show-agent.ts --workspace="<name>"` — read-only. Prints each
  agent's status, Retell from-number, CRM status, and the **effective enroll tag**
  (the agent's own tag, else the workspace tag). Use it to tell the user exactly
  which tag to put on a contact.
- `npx tsx scripts/activate-agent.ts --workspace="<name>" [--dry-run]` — runs the
  same `validateAgentActivation` invariants the app uses, then flips qualifying
  agents to `active`. Connecting CRM does **not** auto-activate; this is the step
  that does. `--dry-run` reports pass/blocked without writing.
- `npx tsx scripts/update-call-window.ts --workspace="<name>" [--start= --end= --run-at= --gap= --attempts=]`
  — rewrites the call window / cadence on the agent's `agent_call_configs`.
  Defaults encode "11pm local nightly for 30 days" (23:00–23:59, run 23:00,
  cadence `[1]`, 30 attempts).
- `npx tsx scripts/link-org-owner.ts --email=<user> --workspace="<name>"` — repair
  for a workspace provisioned without `ownerEmail` (invisible in the app). Adds the
  `organization_members` owner row + backfills `created_by`.

Then for outbound to actually dial: the contact must carry the **effective enroll
tag** in the CRM with a valid phone, and the worker/scheduler (`npm run worker`)
must be running when the call window opens.

> Engine constraint to set expectations: the poller dials each contact **at most
> once per day** (`isEligible` rejects same-day re-dials; `nextEligibleDate` floors
> every gap at 1 day). Same-night rapid retries (e.g. 3 attempts 5 min apart) are
> NOT expressible via call config — they'd need an engine change.

## Guardrails

- Treat the Retell API key, CRM credentials, and webhook secret as secrets: never
  print them back, never commit a filled-in spec, delete temp spec files when done.
- No automatic rollback. If a step fails after the Retell agent/number was created,
  the error names the orphaned `retellAgentId` — surface it so the user can delete
  it in Retell before retrying.
- If a workspace was provisioned WITHOUT `ownerEmail` (so it's invisible in the app),
  repair it with `npx tsx scripts/link-org-owner.ts --email=<user> --workspace="<name>"`
  — it links the user via `organization_members` + backfills `created_by`.
- Endpoint path needs `PROVISION_API_KEY` in the app env (distinct from
  `CRON_SECRET`). Script path needs `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIALS_ENCRYPTION_KEY`, and `NEXT_PUBLIC_APP_URL`
  in `.env.local`.
- Don't place real test calls beyond what the user explicitly approves.
