# Cursor handoff — agent-config console (call settings + HighLevel automations)

Adds full-parity, Claude-driven editing of an existing agent's call settings and
the three optional HighLevel automations, plus carries `pipelineStageMap` through
provisioning. No schema/migration changes — uses the existing tables.

## What changed

**New files**

- `src/lib/console/resolve-agent.ts` — resolves a workspace + agent by NAME
  (newest workspace; agent by name, the sole agent, or a disambiguation error
  listing available names). Service-client based (admin-gated upstream).
- `src/app/api/console/agent-config/route.ts`
  - `GET ?workspace=<name>&agent=<name?>` → `{ callConfig, taskConfig,
    pipelineStageMap, effectiveCrmProvider }`.
  - `POST { workspace, agent?, callConfig?, taskConfig?, pipelineStageMap? }` →
    `callConfig`/`taskConfig` **merge** over the existing row; `pipelineStageMap`
    is **replace-all** (`[]` clears). Validates with the existing Zod schemas.
    Warns if HighLevel features are set on a non-HighLevel agent.
- `src/app/api/console/highlevel/route.ts`
  - `GET ?workspace=<name>&agent=<name?>` → `{ pipelines, fields }` from the
    connected HighLevel account (empty for Follow Up Boss). Sources the IDs used
    in `taskConfig`/`pipelineStageMap`.

**Edited files**

- `src/lib/provisioning/provision-agent.ts` — `agentSpecSchema` now accepts
  `pipelineStageMap` (optional, `pipelineStageMapSchema`), inserted into
  `agent_pipeline_stage_map` after the task-config insert.
- `src/app/admin/page.tsx` — manage panel gains an "Agent automations & config"
  section: agent-name input, **Fetch HighLevel pipelines & fields**, **Load
  current config**, a JSON editor, and **Save config**, with result boxes.
  `SPEC_TEMPLATE` enriched (taskConfig + pipelineStageMap); new `CONFIG_TEMPLATE`.
- `docs/ADMIN-CONSOLE.md`, `docs/PROVISIONING.md` — documented the new routes,
  panel, spec fields, and the three optional HighLevel features.

(`docs/BACKEND_AUDIT_2026-06-27.md` is an unrelated untracked audit doc; include
or omit as you see fit.)

## Verify / ship

- `npm run typecheck` — clean (ran via tsc in sandbox).
- No new env vars; no migration. Reuses `requireAdmin()` gating and the existing
  `agent_call_configs` / `agent_task_configs` / `agent_pipeline_stage_map`
  tables and their Zod schemas.
- Smoke after deploy: `/admin` → enter a HighLevel workspace → Fetch pipelines &
  fields → Load current config → edit → Save → confirm warnings/applied output.

## Suggested commit

```
feat(console): edit existing agent call settings + HighLevel automations

- add /api/console/agent-config (GET/POST: callConfig, taskConfig,
  pipelineStageMap) and /api/console/highlevel (fetch pipelines + fields)
- shared resolve-agent helper (workspace+agent by name)
- carry pipelineStageMap through provision-agent spec
- admin UI panel: fetch HL ids, load/edit/save agent config
- docs: ADMIN-CONSOLE + PROVISIONING
```
