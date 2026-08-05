# Inbound Call Automation (HighLevel)

Productized post-call automation for **Retell inbound agents** connected to a
**HighLevel** workspace. After an inbound call ends (`call_analyzed`), UpSurge:

1. Classifies the inbound outcome from Retell custom analysis data
2. Finds or creates the HighLevel contact by phone
3. Logs the call (note + playable recording when configured)
4. Applies a baseline tag on **every** inbound call, plus an optional outcome tag
5. Creates or updates the contact's opportunity into a mapped pipeline stage
6. Optionally assigns an owner and creates a follow-up task

## Feature gate

Per-agent row in `agent_inbound_configs` with `enabled = true`.

- **Absent or `enabled = false`** → legacy FUB concierge handler
  (`process-inbound-legacy.ts`) runs unchanged (Nil Patel Realty path).
- **`enabled = true`** → productized HighLevel path in `process-inbound.ts`.

No separate feature-flag system — the config row **is** the flag.

## Configuration (UI)

On an inbound agent's **Inbound Automation** tab:

| Setting | Purpose |
| --- | --- |
| Enable | Turns on the productized path |
| Always tag | Applied after every inbound call ends |
| Create contact if missing | New callers become HighLevel contacts |
| Pipeline automation | Create/update opportunity into a stage |
| Default pipeline/stage | Catch-all when no outcome rule matches |
| Outcome rules | Per-outcome stage, status, tag, remove-tags |
| Assignee mode | `fixed` / `dialed_line` / `none` |
| Follow-up task | Optional task after the call |
| Min duration | Suppress writeback on short hangups |

Saved via `PATCH /api/agents/:id` with `inbound_config` + `inbound_routes`.

## Inbound outcomes

Text taxonomy (not the outbound `call_outcome` enum):

`appointment_booked`, `hot_lead`, `interested`, `general_inquiry`,
`existing_client`, `support_request`, `transferred`, `message_taken`,
`not_interested`, `wrong_number`, `spam`, `unknown`

Unrecognized Retell strings fall back to `unknown` (still tagged + routed to
the catch-all stage), so a prompt change cannot silently drop a lead.

Route precedence: **exact outcome → `*` catch-all → config default pipeline**.

## Reliability

- **Atomic claim** on `calls.outcome_claimed_at` (same lease as outbound) so
  webhook re-sends and the reconciler never double-write CRM side effects.
- **Inbound reconciler** (`reconcileInboundCalls`): every 5 minutes the worker
  lists recent Retell inbound calls, diffs against `calls.retell_call_id`, and
  replays missing ones. Also exposed as
  `GET|POST /api/admin/reconcile-inbound-calls` (Bearer `CRON_SECRET`) and a
  Vercel cron (`*/5`).
- **Slack alert** via `ALERT_SLACK_WEBHOOK_URL` when an inbound call finalizes
  with a non-null `crm_error`.

## HighLevel adapter additions

| Method | Endpoint |
| --- | --- |
| `findContactByPhone` | `POST /contacts/search` (phone OR additionalPhones) |
| `createContact` | `POST /contacts/` |
| `addTags` | `POST /contacts/{id}/tags` |
| `removeTags` | `DELETE /contacts/{id}/tags` |
| `assignContact` | `PUT /contacts/{id}` `{ assignedTo }` |

Existing `moveContactToStage` handles opportunity create-or-update.

OAuth scopes already cover these (`contacts.write`, `opportunities.write`) —
no client re-authorization required.

## Migration

Apply `supabase/migrations/0034_inbound_automation.sql` **before** deploying
code that reads the new tables/columns:

- `agent_inbound_configs`
- `agent_inbound_routes`
- `calls.inbound_outcome`, `calls.inbound_route_id`, `calls.opportunity_id`

## Rollout checklist

1. Apply migration 0034; run `npm run db:verify-schema`
2. Deploy web (Vercel) + worker (Railway)
3. On a pilot HighLevel inbound agent: enable automation, set always-tag +
   default pipeline/stage, save
4. Place a live test call; confirm in HighLevel: contact, tag, note/recording,
   opportunity stage; confirm `calls` row is `completed` with null `crm_error`
5. Enable remaining inbound HighLevel agents
