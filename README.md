# UpSurge — AI Voice Agent Platform

Multi-tenant orchestration for [Retell AI](https://www.retellai.com/) outbound voice
agents across **Follow Up Boss** and **HighLevel** CRMs. This is the in-house
productization of the n8n call-flow system: spin up a workspace per client, attach
as many AI agents as you want, configure call cadence and post-call tasks, and the
platform runs the entire dialing + outcome-tagging engine natively — no n8n.

---

## What it does

1. **Create a workspace** (one client, one CRM) and store CRM credentials encrypted.
2. **Add AI agents** linked to Retell agent IDs + from-numbers.
3. **Per agent, configure** how many outbound calls, per day, attempts per contact,
   call window, daily run time, drip spacing, and a variable day-gap cadence.
4. **Optionally create a CRM task** after calls, assigned to a team member.
5. **Provision** — the 7-tag outcome taxonomy is seeded and the engine takes over.

The native engine replaces both n8n workflows:

- **Poller** (was WF1): each day, pulls contacts carrying the enroll tag, filters
  the eligible ones (not terminal, under attempt cap, not already called today, past
  their next-eligible date), and enqueues calls drip-spaced.
- **Outcome processor** (was WF2): on Retell's `call_analyzed` webhook, classifies the
  outcome, writes a CRM note, reconciles tags (stripping the enroll marker on terminal
  outcomes so the contact leaves the flow), optionally creates a task, and advances the
  contact's cadence state.

Three terminal outcomes remove a contact from the flow: **appointment**,
**not_interested**, **dnd**.

---

## Stack

| Layer        | Choice                                            |
| ------------ | ------------------------------------------------- |
| App          | Next.js 14 (App Router) + TypeScript              |
| UI           | Tailwind CSS                                       |
| Data / Auth  | Supabase (Postgres + Auth + Row-Level Security)   |
| Queue        | BullMQ + Redis (ioredis)                           |
| Voice        | Retell AI (`retell-sdk`)                           |
| Validation   | Zod                                                |
| Secrets      | AES-256-GCM credential encryption                  |
| V2 memory    | Anthropic (Haiku) transcript summarization         |

---

## Run it in Cursor (quick start)

```bash
# 1. Install
npm install

# 2. Environment
cp .env.example .env.local
#    Fill in Supabase URL/keys, REDIS_URL, RETELL_API_KEY, RETELL_WEBHOOK_SECRET,
#    CREDENTIALS_ENCRYPTION_KEY (openssl rand -base64 32), CRON_SECRET, ANTHROPIC_API_KEY.

# 3. Database — apply migrations in order against your Supabase project
#    (Supabase SQL editor, or `supabase db push` with the CLI):
#      supabase/migrations/0001_initial_schema.sql
#      supabase/migrations/0002_rls_policies.sql
#      supabase/migrations/0003_defaults_and_helpers.sql
#      supabase/migrations/0004_agent_enroll_tag.sql
#      supabase/migrations/0005_inbound_calls.sql
#      supabase/migrations/0006_agent_direction_and_creds.sql
#      supabase/migrations/0007_reporting_fields.sql
#      supabase/migrations/0008_agent_post_call_webhook.sql
#
#    Or apply 0004–0008 in one shot (requires SUPABASE_ACCESS_TOKEN in .env.local):
#      set -a && source .env.local && set +a && npm run db:apply-pending
#
#    Verify all required columns exist:
#      set -a && source .env.local && set +a && npm run db:verify-schema

# 4. Redis (local)
#    docker run -p 6379:6379 redis   # or use Upstash and set rediss:// URL

# 5. Run the app + the engine (two terminals)
npm run dev        # Next.js — the UI and API
npm run worker     # BullMQ workers + scheduler tick (the dialing engine)
```

Then open http://localhost:3000, sign up, and click **New workspace**.

### Retell webhook

Point your Retell agent's webhook at:

```
POST  {NEXT_PUBLIC_APP_URL}/api/webhooks/retell
```

It's verified with `RETELL_WEBHOOK_SECRET`. Only `call_analyzed` events are processed.

### Scheduling

The worker process runs an internal 30-second scheduler tick by default. Vercel Cron
hitting `/api/cron/daily-poll` is a redundant backup (BullMQ poll job ids are idempotent).
To disable the worker's internal loop intentionally, set `DISABLE_INTERNAL_SCHEDULER=true`
and ensure the external cron is active:

```
POST  {NEXT_PUBLIC_APP_URL}/api/cron/daily-poll
Authorization: Bearer {CRON_SECRET}
```

Health-check every outbound agent under a workspace:

```
npx tsx scripts/poll-doctor.ts <workspaceId>
```

---

## Project layout

```
src/
  app/
    login/                      Auth (email + password via Supabase)
    page.tsx                    Dashboard — workspace cards
    setup/                      5-step provisioning wizard
    workspaces/[id]/            Workspace detail (agents, contacts, taxonomy)
    agents/[id]/                Agent detail (activate/pause, linkage, call history)
    api/
      workspaces/               GET list · POST provision
      workspaces/[id]/          GET detail
      agents/[id]/              GET detail · PATCH status/linkage
      crm/verify/               Pre-save CRM credential check + user list
      webhooks/retell/          Retell call_analyzed handler
      cron/daily-poll/          External-cron scheduler entrypoint
  components/                   UI primitives + nav shell
  lib/
    crm/                        Pluggable CrmAdapter (FUB + HighLevel)
    engine/                     poller · caller · process-outcome · cadence ·
                                tags · outcome · memory · scheduler
    queue/                      BullMQ queues + workers
    retell/                     Retell client + signature verification
    supabase/                   Server / browser / middleware clients
    crypto.ts                   AES-256-GCM credential encryption
    validation.ts               Zod schemas (wizard payload)
  types/                        Shared domain types
worker/
  index.ts                      Engine entrypoint (workers + scheduler)
supabase/migrations/            Schema · RLS · defaults & helpers
```

---

## Adding a new CRM

The engine is 100% CRM-agnostic — it only ever talks to a `CrmAdapter`
(`src/lib/crm/types.ts`). To add a provider:

1. Implement the `CrmAdapter` interface in `src/lib/crm/<provider>.ts`.
2. Register it in `src/lib/crm/index.ts`.
3. Add the provider to the `crm_provider` enum (migration) and the Zod
   credential union (`src/lib/validation.ts`).

Nothing in the poller, caller, or outcome processor changes.

---

## Security notes

- CRM credentials are encrypted at rest (AES-256-GCM) and only decrypted server-side
  inside the engine. They are never returned to the browser.
- The service-role Supabase key is server-only and bypasses RLS for multi-table
  provisioning after the user is authorized. All user-facing reads go through the
  RLS-scoped anon client.
- The Retell webhook verifies an HMAC signature on the raw request body before doing
  any work.

See `docs/ARCHITECTURE.md` for the engine data-flow and `docs/V2-MEMORY.md` for the
real-time agent-memory design.
