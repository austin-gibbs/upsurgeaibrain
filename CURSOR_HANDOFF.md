# Cursor Handoff — HighLevel Pipeline Routing + OAuth Token Refresh

_Generated 2026-06-22. This describes work already written into this working tree
(uncommitted). Cursor opens the same folder, so all files below are already present —
nothing was pushed to GitHub yet._

---

## Paste this into Cursor to get oriented

> I'm continuing work on UpSurge. Two features were just implemented in the working
> tree (not yet committed): (1) **app-driven HighLevel pipeline routing** — move a
> contact's opportunity to a pipeline stage based on the call outcome, configured
> per-agent in the UI, no hand-built HighLevel workflow; and (2) **HighLevel OAuth
> token refresh** — the adapter auto-refreshes the short-lived access token using a
> stored refresh token, with a connect/callback flow to obtain it.
>
> Read `CURSOR_HANDOFF.md` first, then `CLAUDE.md`, `docs/ARCHITECTURE.md`, and
> `supabase/migrations/0009_pipeline_stage_automation.sql`. The engine entry point
> for routing is `src/lib/engine/process-outcome.ts` (step "4c") → `pipeline-routing.ts`
> → `src/lib/crm/highlevel.ts`. The OAuth helpers are in `src/lib/crm/highlevel-oauth.ts`.
>
> My immediate goals: (a) apply migration 0009, (b) set the new env vars and register
> the HighLevel Marketplace app + redirect URI, (c) run the end-to-end test checklist
> in this doc against a sandbox HighLevel sub-account. Don't place real outbound calls
> beyond agreed testing. Keep behavior parity with the live n8n system as the cutover bar.

---

## What was built

### 1. Pipeline routing (outcome → pipeline stage)
After a call is classified, the engine looks up a per-agent mapping of `outcome →
{pipeline, stage}` and moves the contact's HighLevel opportunity there (finds the
existing opportunity, preferring one already in the target pipeline; creates one if
none exists). HighLevel-only and best-effort: it never blocks cadence advance, and is
a no-op for Follow Up Boss (no pipelines) or when no stage is mapped for an outcome.

Configured per-agent in **Agent detail → Tasks & automations → Pipeline routing**:
a toggle plus, for each of the 7 outcomes, a pipeline dropdown + dependent stage
dropdown (default "— No move —").

### 2. HighLevel OAuth token refresh
HighLevel access tokens expire (~24h). The adapter now stores `refreshToken` +
`expiresAt` in the encrypted credentials and refreshes automatically — proactively
when the token is at/near expiry, and reactively on a `401` (refresh once, retry).
Rotated tokens are persisted back to the originating row (`agents` or `workspaces`)
via a persistor callback wired in the CRM factory. A connect/callback flow obtains
the initial refresh token; pasting a static token still works but won't auto-refresh.

### 3. Already-integrated HighLevel workspaces (the gap you flagged)
The routing editor now keys off the **effective** CRM — the agent's own provider/creds
when set, otherwise the ones inherited from its workspace. Older workspaces configured
HighLevel at the workspace level, so their agents have neither field of their own; the
GET `/api/agents/:id` route now returns `effectiveCrmProvider` +
`hasEffectiveCrmCredentials`, and the page uses those to show the editor and load
pipelines (the pipelines endpoint already falls back to workspace creds). Routing stays
**per-agent** by design (your choice), so each agent in a HighLevel workspace gets its
own editable map on its detail page.

---

## Setup checklist (do these in order)

1. **Apply migration 0009.**
   `supabase/migrations/0009_pipeline_stage_automation.sql` adds
   `agent_task_configs.pipeline_automation_enabled` and the `agent_pipeline_stage_map`
   table (PK `(agent_id, outcome)`, RLS scoped like task configs). Apply with your
   normal flow (`scripts/apply-migrations-api.mjs` or `npx supabase db query --linked`).

2. **Set env vars** (`.env.local`, and Vercel + Railway for deploy). New keys are in
   `.env.example`:
   - `HIGHLEVEL_CLIENT_ID`
   - `HIGHLEVEL_CLIENT_SECRET`

3. **Register a HighLevel Marketplace app** (HighLevel → Settings → Apps / the
   developer marketplace). Set the **redirect URI** to exactly:
   `{NEXT_PUBLIC_APP_URL}/api/oauth/crm/callback`
   (e.g. `https://upsurgeprosai.com/api/oauth/crm/callback`). Grant scopes:
   `contacts.readonly contacts.write opportunities.readonly opportunities.write
   locations.readonly users.readonly`. Copy the client id/secret into the env vars above.

4. **Connect a location.** On a HighLevel agent's detail page, click **Connect via
   OAuth** → choose the sub-account → you're redirected back with
   `?crm=connected`. Tokens are stored encrypted on the agent and auto-refresh
   from then on.

---

## How routing flows at runtime

```
Retell call_analyzed webhook
  └─ process-outcome.ts (classify → CRM note → tags → task → webhook)
       └─ step 4c: if HighLevel && pipeline_automation_enabled
            └─ applyPipelineRouting()            src/lib/engine/pipeline-routing.ts
                 └─ reads agent_pipeline_stage_map for (agent_id, outcome)
                 └─ crm.moveContactToStage()      src/lib/crm/highlevel.ts
                      └─ search opp by contact → PUT stage, else POST new opp
```

The adapter's `request()` wrapper transparently refreshes the OAuth token before/around
every HighLevel call, so routing (and all other HighLevel calls) survive token expiry.

---

## File inventory

**New files**
- `supabase/migrations/0009_pipeline_stage_automation.sql` — toggle column + map table + RLS
- `src/lib/engine/pipeline-routing.ts` — engine helper: outcome → stage move
- `src/lib/crm/highlevel-oauth.ts` — token refresh, code exchange, authorize URL
- `src/components/agent-form/PipelineStageSettings.tsx` — the routing editor UI
- `src/app/api/agents/[id]/pipelines/route.ts` — GET pipelines+stages for the UI
- `src/app/api/agents/[id]/crm/connect/route.ts` — start OAuth (redirect)
- `src/app/api/oauth/crm/callback/route.ts` — finish OAuth (store tokens)

**Modified files (this work)**
- `src/lib/crm/highlevel.ts` — `listPipelines`/`moveContactToStage` + auto-refresh in `request()`
- `src/lib/crm/types.ts` — `CrmPipeline`/`MoveStageInput`, refresh fields, persistor type
- `src/lib/crm/index.ts` — factory wires the token persistor (agent/workspace row)
- `src/lib/engine/process-outcome.ts` — step 4c calls `applyPipelineRouting`
- `src/lib/validation.ts` — pipeline map schema + optional OAuth fields in creds
- `src/types/index.ts`, `src/types/database.ts` — toggle column + map table types
- `src/components/agent-form/types.ts` — `Pipeline`/`StageMapEntry` + task config field
- `src/app/api/agents/[id]/route.ts` — GET returns effective CRM + map; PATCH persists map
- `src/app/agents/[id]/page.tsx` — renders editor, effective-CRM gating, OAuth button
- `.env.example` — `HIGHLEVEL_CLIENT_ID` / `HIGHLEVEL_CLIENT_SECRET`

**Unrelated uncommitted work also in the tree (NOT part of this feature)** — an inline
test-call feature: `src/lib/engine/caller.ts`, `src/lib/retell/client.ts`,
`src/components/workspace/WorkspaceOpsTab.tsx`, `src/app/api/workspaces/[id]/test-call/`.
Decide separately whether to commit these with or apart from the routing/OAuth work.

---

## Test checklist (sandbox HighLevel sub-account)

- [ ] `npm run typecheck` passes (currently clean).
- [ ] Migration 0009 applied; `agent_pipeline_stage_map` exists with RLS.
- [ ] OAuth connect → callback stores tokens; agent shows `?crm=connected`.
- [ ] Agent detail (HighLevel) shows Pipeline routing; dropdowns populate from the sub-account.
- [ ] Save a map (e.g. `appointment → Sales / Booked`); reload — selection persists.
- [ ] Existing **workspace-level** HighLevel agent (no per-agent creds) also shows the editor.
- [ ] Trigger a test `call_analyzed` for a mapped outcome → opportunity moves to the stage in HighLevel.
- [ ] Unmapped outcome / FUB agent → no move, no error, cadence still advances.
- [ ] Force token expiry (set `expiresAt` in the past) → next HighLevel call refreshes + persists silently.

---

## Notes / follow-ups

- **Token refresh concurrency across processes.** Refresh is de-duped within one adapter
  instance. The Next.js app and the BullMQ worker are separate processes; if both refresh
  the same location at the same instant, HighLevel rotates the refresh token and the
  loser's write is stale. Rare, and a 401-retry recovers it, but consider a short DB lock
  or last-writer-wins-by-`expiresAt` if you see refresh churn under load.
- **Opportunity status.** `moveContactToStage` keeps status `open` unless a status is
  passed. If you want terminal outcomes (appointment/not_interested/dnd) to also mark the
  opp won/lost/abandoned, extend the map or pass `status` from `applyPipelineRouting`.
- **Migration history.** Still effectively a single-commit repo; this work is uncommitted.
  Commit as a focused change set once you've separated the inline test-call work.

## Git state

Nothing pushed. `origin` = `git@github.com:austin-gibbs/upsurgeaibrain.git`, branch `main`.
All changes are local working-tree edits. (When generating this doc the `.git/index.lock`
was held by another process — close other git clients before committing.)
