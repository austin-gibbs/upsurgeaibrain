# Post-call automations — engine + runbook

A config-driven post-call automation engine. When a Retell call is analyzed,
the engine matches the call against workspace-defined **triggers** and fires an
**action** (a webhook to a HighLevel Inbound Webhook, or an internal notify).
The first shipping use case: **when a caller asks for a link on the call, text
it to them** — Retell captures `link_requested` / `link_type` in
`custom_analysis_data`, the engine resolves the URL and POSTs it to the client's
HighLevel workflow, which sends the SMS.

**A new automation is a new database row — never a code deploy.** This is the
productized, sellable superset of the old single per-agent post-call webhook
(`dispatchPostCallWebhook`, keyed only on outcome).

## How it fits the existing pipeline

The engine hooks into the existing outcome pipeline; it does not replace it.

```
Retell call_analyzed webhook
  → /api/webhooks/retell/route.ts
    → processRetellWebhook()            (src/lib/engine/process-outcome.ts)
        … CRM sync, tags, tasks, existing 4b webhook, pipeline routing …
        → evaluateAutomations()          (4b-automations, best-effort/try-catch)
             1. load enabled triggers for the workspace (+ this agent)
             2. build a context snapshot from custom_analysis_data (+ outcome/summary/transcript)
             3. match each trigger (pure, conditions.ts)
             4. dedupe against recent runs (per trigger + contact phone)
             5. resolve the link (link_type → automation_links.url)
             6. insert an automation_runs row (queued) with the rendered request
             7. enqueue an executor job
  → automation.worker consumes post-call-automation queue
    → executeAutomationRun()            (POST the webhook; 2xx → sent, else retry/dead)
```

`evaluateAutomations` is wrapped in try/catch inside `process-outcome.ts` — an
automation failure never blocks CRM sync or cadence advance.

## Data model (migration `0033_post_call_automations.sql`)

| Table | Purpose |
| --- | --- |
| `automation_triggers` | The rule set. `workspace_id`, `agent_id` (NULL = all agents), `match_type` (`all`/`any`), `conditions` (jsonb), `action_type` (`webhook`/`highlevel_sms`/`internal_notify`), `action_config` (jsonb), `dedupe_window_hours`, `max_attempts`, `only_outcomes`. |
| `automation_links` | Per-workspace link map keyed by `link_type` → `url`. Lets the HighLevel workflow stay "dumb" and identical per client; swapping a URL is a data edit. |
| `automation_runs` | Durable queue + audit log. One row per match: `queued → sent | failed | dead | skipped`, with the resolved `request_url`/`request_payload` and last delivery result. Source of truth for retries and dedupe. |

RLS: workspace members can read their rows; all writes go through the service
role (engine/worker/console routes).

## Conditions

Each condition is `{ field, operator, value? }`. `field` reads from Retell
`custom_analysis_data`, plus three pseudo-fields: `outcome`, `summary`,
`transcript`.

| Operator | Meaning |
| --- | --- |
| `is_true` / `is_false` | Boolean coercion — also matches the strings `"true"`, `"yes"`, `"y"`, `"1"`. |
| `eq` / `neq` | Case- and whitespace-insensitive string compare. |
| `contains` | Case-insensitive substring. |
| `exists` / `not_exists` | Present and non-empty vs. absent/empty. |
| `in` | Membership; `value` may be an array or a comma string. |

`match_type: "all"` = every condition (AND); `"any"` = at least one (OR). An
empty `conditions` array matches — so a trigger can fire purely on the
`only_outcomes` gate (e.g. "on every appointment").

## Actions

`action_config` fields:

- `url` — delivery endpoint (required for `webhook` / `highlevel_sms`).
- `method` — `POST` (default) / `PUT` / `PATCH`.
- `headers` — extra request headers (e.g. an auth header).
- `message_template` — the text to deliver, with `{{...}}` placeholders.
- `link_type_field` — which `custom_analysis_data` field names the link (e.g. `link_type`).
- `static_link_type` — OR pin one link_type regardless of the call.
- `payload_template` — a full custom body (deep-rendered); overrides the default shape.

**Template placeholders** (`{{ path }}`, unknown → empty string, never leaks a raw token):
`{{contact.first_name}}`, `{{contact.full_name}}`, `{{contact.email}}`,
`{{contact.phone}}`, `{{link.url}}`, `{{link.type}}`, `{{link.label}}`,
`{{outcome}}`, `{{summary}}`, `{{transcript}}`, `{{fields.<name>}}` (or a bare
`{{<name>}}`) for any `custom_analysis_data` field.

**Default webhook payload** (when no `payload_template` is set) matches the shape
a HighLevel Inbound Webhook can map:

```json
{
  "event": "post_call_automation",
  "trigger_name": "Send requested link",
  "outcome": "follow_up",
  "contact": { "name": "...", "first_name": "...", "email": "...", "phone": "+1..." },
  "link_type": "buyer_guide",
  "link_url": "https://…",
  "message": "Hi Paul, here's the info you asked for: https://…",
  "summary": "…",
  "custom_analysis_data": { "...": "..." }
}
```

## Reliability

- Every match becomes a durable `automation_runs` row **before** enqueue, so a
  Redis outage never loses an automation.
- The executor (`automation.worker`) POSTs with a 10s timeout; 2xx → `sent`,
  non-2xx → `failed` and BullMQ backs off. At `max_attempts` the run is marked
  `dead` (no more retries).
- A **60s drain sweep** in the worker (`drainAutomationRuns`) re-enqueues
  `queued`/retryable-`failed` runs whose job was lost. Idempotent via a
  deterministic jobId (`automation-<runId>`).
- **Dedupe**: within `dedupe_window_hours`, a repeat match for the same trigger
  + contact phone is recorded as `skipped` instead of re-sending.

Env toggles: `AUTOMATION_WORKER_ENABLED=false` disables the worker;
`AUTOMATION_WORKER_CONCURRENCY` (10), `AUTOMATION_WORKER_RATE_MAX` (20),
`AUTOMATION_WORKER_RATE_DURATION_MS` (1000) tune throughput.

## Admin console

`/admin/automations` (session + app-admin gated), linked from `/admin`.
Scoped by workspace name (agent optional). Three panels: **Triggers**
(list/create/enable-disable/delete), **Link map** (upsert/delete), **Run log**
(the audit trail with a status filter).

API routes (all `requireAdmin`-gated):

| Route | Methods |
| --- | --- |
| `/api/console/automations` | `GET ?workspace=&agent=` list · `POST {workspace, agent?, ...trigger}` create |
| `/api/console/automations/[id]` | `PATCH` update (merge) · `DELETE` |
| `/api/console/automations/runs` | `GET ?workspace=&status=&triggerId=&limit=` |
| `/api/console/automations/links` | `GET ?workspace=` · `POST {workspace, link_type, url, label?}` · `DELETE ?workspace=&link_type=` |

## Setup — Paul Avratin (United Real Estate Experts) example

**1. Retell agent (`custom_analysis_data`).** In the agent's post-call analysis,
add two fields the LLM fills from the conversation:

- `link_requested` (boolean) — "Did the caller ask for a link/info to be sent?"
- `link_type` (string, enum) — which link, e.g. `buyer_guide`, `seller_guide`,
  `home_valuation`. Constrain to the link types you map below.

**2. Link map** (`/admin/automations` → Link map, or `POST .../links`):

| link_type | url |
| --- | --- |
| `buyer_guide` | `https://…/buyer-guide.pdf` |
| `seller_guide` | `https://…/seller-guide.pdf` |
| `home_valuation` | `https://…/valuation` |

**3. HighLevel workflow.** Create a workflow with an **Inbound Webhook** trigger;
copy its URL. Add a **Send SMS** step whose body uses the inbound webhook's
`message` (or build the text from `link_url`). Because the app resolves the URL,
the same workflow works for every client — only the webhook URL differs.

**4. Trigger** (`/admin/automations` → New trigger):

```json
{
  "name": "Send requested link",
  "description": "Caller asked for a link — text it via HighLevel.",
  "enabled": true,
  "match_type": "all",
  "conditions": [
    { "field": "link_requested", "operator": "is_true" }
  ],
  "action_type": "highlevel_sms",
  "action_config": {
    "url": "https://services.leadconnectorhq.com/hooks/<INBOUND_WEBHOOK>",
    "link_type_field": "link_type",
    "message_template": "Hi {{contact.first_name}}, here's the info you asked for: {{link.url}}"
  },
  "dedupe_window_hours": 24,
  "max_attempts": 5,
  "only_outcomes": null
}
```

**5. Verify.** Place a test call where you ask for a guide. Confirm in the Run
log the run went `queued → sent` (HTTP 2xx), and the SMS arrived. If it shows
`failed`/`dead`, `last_error` and `response_status` explain why (usually a bad
webhook URL or a HighLevel workflow error).

## Deploy

1. Apply the migration: `npm run db:apply-pending` (or run `0033` via your
   migration path).
2. Regenerate/confirm `src/types/database.ts` includes the three new tables
   (already added).
3. Deploy the app (Vercel) and the worker (Railway). The worker starts the
   automation worker + drain sweep automatically unless
   `AUTOMATION_WORKER_ENABLED=false`.
4. Configure a client in `/admin/automations` (link map + trigger) and test.

## Files

| File | Purpose |
| --- | --- |
| `supabase/migrations/0033_post_call_automations.sql` | The three tables + RLS. |
| `src/lib/engine/automations/types.ts` | Shared types. |
| `src/lib/engine/automations/conditions.ts` | Pure trigger matcher. |
| `src/lib/engine/automations/render.ts` | Pure `{{...}}` template renderer. |
| `src/lib/engine/automations/evaluate.ts` | The hook called from `process-outcome`. |
| `src/lib/engine/automations/execute.ts` | Executor — POSTs the webhook, retry/dead-letter. |
| `src/lib/engine/automations/drain.ts` | Fallback drain sweep for lost jobs. |
| `src/lib/engine/automations/schema.ts` | Zod validation for the admin API. |
| `src/lib/engine/automations/conditions.test.ts` | Unit tests (matcher + renderer). |
| `src/lib/queue/queues.ts` | `post-call-automation` queue + `enqueueAutomation`. |
| `src/lib/queue/workers/automation.worker.ts` | The executor worker. |
| `worker/index.ts` | Starts the worker + 60s drain sweep. |
| `src/app/api/console/automations/**` | Admin API routes. |
| `src/app/admin/automations/page.tsx` | Admin console UI. |
