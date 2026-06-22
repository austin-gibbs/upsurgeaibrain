# Architecture

UpSurge is a multi-tenant control plane plus a native dialing engine. The control
plane (Next.js) is where humans configure clients; the engine (a BullMQ worker
process) is what actually runs calls and reacts to outcomes. They share one Postgres
(Supabase) database and a Redis instance.

## Tenancy model

```
organization (your agency)
└── workspace (one client, one CRM connection)
    ├── workspace_outcome_tags   (the 7-tag taxonomy, seeded on create)
    ├── contacts                 (mirror of CRM contacts carrying the enroll tag)
    └── agent (a Retell voice agent)
        ├── agent_call_configs   (caps, window, cadence)
        ├── agent_task_configs   (post-call task rules)
        ├── calls                (one row per dial attempt)
        └── agent_memory         (V2 — rolling per-contact memory)
```

A **workspace** binds exactly one CRM provider and one set of (encrypted) credentials.
Row-Level Security scopes every user-facing read to the caller's organization
memberships; the engine uses the service-role key to bypass RLS for cross-tenant
background work.

## The two engine loops

The platform reproduces the verified n8n logic as typed code. There are two loops.

### 1. Poll → enqueue (replaces Workflow 1)

```
scheduler tick (every minute)
  └── for each ACTIVE agent whose daily_run_at == now (in workspace tz)
        └── enqueue a poll job   (jobId = poll:<agentId>:<date>  → idempotent)

poll worker
  └── pollAgent:
        load agent + call config + workspace
        verify agent is active and inside its call window
        crm.getContactsByTag(enroll_tag)
        upsert into contacts (preserving cadence state)
        filter isEligible():
            not terminal
            attempt_count < max_attempts_per_contact
            last_called_on != today
            today >= next_eligible_on
        require at least one phone
        cap at max_calls_per_day
        enqueue a call job per contact, delayed i * drip_seconds
            (jobId = <agentId>:<contactId>:<date>  → idempotent)
```

Idempotent job IDs mean a double-fired scheduler or a retried poll never
double-dials a contact within a day.

### 2. Dial → outcome (replaces Workflow 2)

```
call worker
  └── placeCall:
        insert calls row (status=queued)
        build Retell dynamic variables (incl. V2 memory)
        RetellClient.createPhoneCall(from, to, override_agent_id, vars, metadata.call_id)
        update calls row (status=dialing)
        stamp contact.attempt_count++ and last_called_on
        best-effort CRM "dialed today" tag

Retell  --(call_analyzed webhook)-->  /api/webhooks/retell
  └── verify HMAC signature on raw body
      processRetellWebhook:
        correlate via metadata.call_id (fallback: retell_call_id)
        idempotency guard (skip if call already completed)
        classifyOutcome():  ALIAS map → CallOutcome; unknown → no_answer;
                            in_voicemail overrides to voicemail
        crm.addNote(formatted: AI Agent / Summary / Outcome)
        reconcileTags():    strip all outcome tags (+ enroll tag if terminal),
                            add the current outcome tag  → crm.setTags()
        if task configured and outcome matches → crm.createTask()
        update contact cadence:
            terminal  → is_terminal=true, next_eligible_on=null (leaves the flow)
            otherwise → next_eligible_on = today + cadence_day_gaps[attempt]
        update calls row (status=completed, outcome, summary, transcript, applied_tag)
        updateMemoryAfterCall()   (V2)
```

## Outcome taxonomy

Seeded per workspace on creation (`seed_default_outcome_tags`):

| Outcome                     | Tag                              | Terminal |
| --------------------------- | -------------------------------- | -------- |
| voicemail                   | `upsurge-voicemail-ai`           |          |
| no_answer                   | `upsurge-noanswer-ai`            |          |
| appointment                 | `upsurge-appointment-ai`         | ✓        |
| not_interested              | `upsurge-notinterested-ai`       | ✓        |
| dnd                         | `upsurge-dnd-ai`                 | ✓        |
| interested_no_appointment   | `upsurge-interestednoappointment-ai` |      |
| follow_up                   | `upsurge-followup-ai`            |          |

Terminal outcomes strip the enroll tag, which is the same mechanism the poller uses to
decide eligibility — so a contact who books, declines, or asks for DND is removed from
the call flow everywhere at once.

## CRM abstraction

Everything CRM-specific lives behind `CrmAdapter` (`src/lib/crm/types.ts`):
`getContactsByTag`, `getContact`, `setTags`, `addNote`, `createTask`, `listUsers`,
`verifyCredentials`. The poller, caller, and outcome processor never branch on
provider. Provider quirks are contained in the adapters — e.g. Follow Up Boss tasks use
the numeric `assignedUserId` and tags are replaced via full-array `PUT /people/{id}`;
HighLevel is location-scoped with a `Version` header and tasks live under
`/contacts/{id}/tasks`.

## Why native queue instead of n8n

- **Per-tenant isolation and scale** — one worker fleet serves all workspaces; calls
  are spaced with per-job delays rather than a single global wait node.
- **Idempotency** — deterministic job IDs prevent double-dials that were possible with
  webhook re-fires in n8n.
- **Typed, testable logic** — the outcome classifier, cadence math, and tag
  reconciliation are unit-testable functions instead of code nodes.
- **One source of truth** — config, state, and history all live in Postgres next to the
  data the UI reads.
