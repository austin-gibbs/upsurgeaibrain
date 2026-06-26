# Game Plan — "Atlas," the Owner Assistant Agent

> Proposed design. **Nothing is implemented yet** — this is the plan to accept before any
> Cursor handoff. Working name for the agent is **Atlas** (swap freely).

_Drafted: 2026-06-25._

---

## 1. What we're building (one paragraph)

A **third kind of agent**: an inbound line the *business owner* calls to get things done. Unlike
the passive concierge ("Mia," `process-inbound.ts`) that only gathers caller details and documents
them after the call, Atlas **takes real actions during the live call** by invoking tools: look up a
contact in the CRM, send an email from the owner's Gmail, book an appointment on the owner's Google
Calendar (with invites), delegate a task to a team member in the CRM, and place a one-off outbound
call to relay a message to a third party. The app becomes the owner's autonomous assistant — "the
brain that takes action" — reusing the CRM adapter, per-agent credentials, webhook verification,
queue, and V2 memory we already have.

## 2. The core mechanism (this is the whole feature)

Retell **custom functions**. You define a function in the Retell agent (name, description,
parameters, a URL). Mid-call, the LLM decides it needs to act, and Retell **POSTs to our URL** with
the arguments; we execute and return JSON; the agent speaks the result and continues. Key facts that
shape the design (from Retell docs):

- Requests are signed with `X-Retell-Signature` (same HMAC scheme we already verify).
- Default timeout **2 minutes**, retried up to 2× on failure; result is capped at **15,000 chars**.
- **Speak-during-execution** lets the agent say "one moment, pulling that up…" while our handler runs,
  which covers CRM/Gmail/Calendar latency.
- Inbound calls also fire an **`inbound` webhook before connect** where we can return
  `retell_llm_dynamic_variables` and even override the agent — our hook to inject owner context and
  do the caller allow-list check *before* the conversation starts.

So Atlas is mostly **synchronous tool calls during the call**; post-call processing is minimal (log
a summary, finalize anything queued). This is the inverse of the concierge, whose work is all
post-call.

## 3. How it reuses what already exists

| Existing piece | Reused for Atlas |
| --- | --- |
| `CrmAdapter` (`src/lib/crm/*`) | `find_contact`, `add_note`, `delegate_task` — zero new code beyond a name-search method |
| Per-agent creds + `getCrmAdapterForAgent` | Atlas carries the owner's CRM connection like any agent |
| `verifyRetellSignature` / per-agent secret helpers | Authenticating the tool POSTs |
| `RetellClient.createPhoneCall` + BullMQ call queue | `relay_call` (one-off outbound message delivery) |
| `crypto.ts` (AES-256-GCM) + HighLevel OAuth pattern (`highlevel-oauth.ts`, `/api/oauth/crm/callback`) | Template for the new **Google OAuth** (Gmail + Calendar) |
| V2 memory loop (`memory.ts`) | Standing owner memory — recurring contacts, open delegations, preferences |

The **only genuinely new external integration is Google**, and one OAuth consent covers both Gmail
send and Calendar.

## 4. Architecture

```
Owner dials Atlas line
      │
      ▼
Retell  ──(inbound webhook, pre-connect)──►  /api/retell/inbound
      │                                         ├─ resolve agent/workspace by agent_id
      │                                         ├─ allow-list check on from_number
      │                                         └─ return dynamic vars (owner name, date,
      │                                            open tasks, is_owner flag)
      ▼
Live conversation. LLM decides to act:
      │
      ├─ tool: find_contact   ─┐
      ├─ tool: send_email      │   POST (signed)        ┌─────────────────────────────┐
      ├─ tool: book_appointment├──────────────────────► │ /api/retell/tools/[tool]    │
      ├─ tool: delegate_task   │                        │  verify sig → resolve agent │
      ├─ tool: add_note        │                        │  authorize caller           │
      └─ tool: relay_call     ─┘                        │  dispatch → handler         │
                                                        │  idempotency + audit log    │
                                                        └──────────────┬──────────────┘
                                                                       ▼
                                       CrmAdapter / Gmail API / Calendar API / call queue
                                                                       │
                                              JSON result ◄────────────┘  (agent speaks it)
      │
      ▼
Call ends ──(call_analyzed webhook)──►  /api/webhooks/retell  → processAssistantCall()
                                          (log call + summary, finalize queued relay,
                                           update owner memory)
```

### New endpoints

- **`POST /api/retell/inbound`** — Retell inbound pre-connect webhook. Allow-list check + inject
  owner context as dynamic variables. (If number not allowed: return a locked-down variable so the
  prompt politely refuses to take actions.)
- **`POST /api/retell/tools/[tool]`** — single dispatcher for all custom functions. Verifies the
  signature (reuse `verifyRetellSignature` + `perAgentWebhookSecretsFromBody`), resolves the agent,
  authorizes the caller, dispatches to the handler, writes an audit row, returns JSON.
- **`GET /api/oauth/google/callback`** — Google OAuth callback (mirror of the existing CRM OAuth
  callback). Plus a connect/initiate route + a small UI button on the agent page.

### New library code (mirrors `src/lib/engine/*` style — small, testable)

```
src/lib/assistant/
  authorize.ts        # isOwnerCaller(agent, fromNumber) — allow-list match (+ optional PIN later)
  dispatch.ts         # routes tool name → handler; idempotency + audit
  tools/
    find-contact.ts   # CRM search by name/phone/email
    add-note.ts       # crm.addNote
    delegate-task.ts  # crm.createTask, assignee resolved from listUsers by name
    send-email.ts     # Gmail API send as owner (+ optional CRM note)
    book-appointment.ts# Calendar event + attendees (invites)
    relay-call.ts      # enqueue one-off outbound relay call
  google/
    oauth.ts          # token exchange + refresh (template: highlevel-oauth.ts)
    gmail.ts          # send message
    calendar.ts       # create event with attendees
process-assistant.ts  # post-call handler (sibling of process-inbound.ts)
```

## 5. Data model (one migration: `0021_owner_assistant.sql`)

- `agents.inbound_mode text default 'concierge' check in ('concierge','assistant')` — distinguishes
  Atlas from Mia without disturbing the existing `direction` logic (Atlas is still `direction =
  'inbound'`). The inbound webhook router branches on this.
- `agents.owner_phone_numbers jsonb` — E.164 allow-list of numbers permitted to command the agent.
- `agents.owner_name text`, `agents.owner_email text` — for greetings and the email "from" identity.
- **`owner_integrations`** table — `(id, workspace_id, agent_id, provider 'google',
  credentials_encrypted, scopes, status, created_at)`. Generic so we can add Microsoft later without
  schema churn. Tokens encrypted at rest via `crypto.ts`.
- **`assistant_actions`** audit table — `(id, workspace_id, agent_id, retell_call_id, tool,
  args_redacted jsonb, status, result_summary, idempotency_key unique, created_at)`. Every action the
  agent takes is recorded so the owner can review what Atlas did — and it backs idempotency.

## 6. The tools (MVP — all four capability areas)

| Tool | Does | Integration | Notes |
| --- | --- | --- | --- |
| `find_contact` | Search CRM by name/phone/email, return matches | CrmAdapter (add `searchContacts`) | Disambiguates "James Conley" → returns id+email+phone |
| `add_note` | Append a note to a contact | CrmAdapter (exists) | — |
| `delegate_task` | Create/assign a task to a team member | CrmAdapter (exists) | Assignee matched from `listUsers` by spoken name |
| `send_email` | Send email from owner's Gmail to a recipient | **Gmail API** | Agent reads back recipient+subject+body, then sends; logs note to CRM |
| `book_appointment` | Create calendar event + invite attendees | **Google Calendar API** | Returns confirmed time; invites sent natively |
| `relay_call` | Place a one-off call to a third party to deliver a message | RetellClient + call queue | Uses a dedicated "relay" Retell agent; message passed as dynamic vars; post-call we confirm delivery |

**Confirmation pattern (in the prompt):** for any external/irreversible action (`send_email`,
`book_appointment`, `relay_call`), Atlas verbally confirms the details before invoking the tool.
**Idempotency:** dispatcher dedupes on `(retell_call_id, tool, hash(args))` so a retry or a repeated
intent never double-sends or double-books.

## 7. Owner authentication (your choice: phone allow-list)

`isOwnerCaller()` matches `call.from_number` against `agents.owner_phone_numbers`. If it doesn't
match, the inbound webhook sets `is_owner=false` and the prompt restricts Atlas to a polite "I can
only take actions for the account owner" — no tools fire.

> ⚠️ **Caller ID is spoofable.** The audit log (`assistant_actions`) means every action is reviewable,
> and the design leaves a **drop-in slot for a spoken PIN** (`authorize.ts` already takes the call
> object) — flip it on later with no rework if you want defense-in-depth before sending email or
> moving anything money-adjacent.

## 8. Build order (fastest path to a working call)

All four capabilities are in the MVP; this is just the sequence that gets a **live, end-to-end
working Atlas call soonest**, de-risking the loop before the Google lift.

**Phase 0 — the loop, on existing integrations (no new OAuth).**
Migration, `inbound_mode`, inbound webhook (allow-list + context), tool dispatcher, audit table,
`find_contact` + `add_note` + `delegate_task`, the Retell agent + prompt + function definitions.
→ At the end of Phase 0 you can **call Atlas and have it look up a contact and delegate a task,
fully working.** This proves the hardest plumbing (signing, dispatch, latency, prompt) with zero new
external dependencies.

**Phase 1 — Google (Gmail + Calendar).**
Google OAuth connect + callback (template: HighLevel OAuth), `owner_integrations`, `send_email`,
`book_appointment`. One consent screen, both scopes.

**Phase 2 — Relay call.**
Dedicated relay Retell agent, `relay_call` tool → enqueue one-off outbound, `process-assistant.ts`
delivery confirmation. Reuses the outbound caller almost entirely.

**Phase 3 — Owner memory (the "brain" differentiator).**
Extend the V2 memory loop so Atlas remembers across calls: recurring contacts, open delegations,
owner preferences ("James always means James Conley"). The seam is the same `summarizeForMemory` +
jsonb columns described in `docs/V2-MEMORY.md`.

## 9. Retell-side setup (documented like the concierge guide)

A new `docs/retell-owner-assistant.md` will spell out: create the Atlas agent, paste the prompt,
define each custom function (name, description, params, URL → `/api/retell/tools/{tool}`,
speak-during-execution ON), set the inbound webhook → `/api/retell/inbound`, bind the owner's line,
set `agents.retell_agent_id` + `inbound_mode='assistant'` + `owner_phone_numbers`. Functions can be
provisioned by hand in the dashboard first, then optionally via the Retell `update-agent` API (we
already call it for webhooks).

## 10. Risks / decisions to watch

1. **Latency budget.** CRM + Gmail + Calendar are external calls inside the function timeout.
   Mitigation: speak-during-execution, tight per-call HTTP timeouts (`http.ts`), and keeping handlers
   to a single round-trip where possible.
2. **Idempotency on irreversible actions.** Covered by the dispatcher dedupe + verbal confirmation,
   but worth a dedicated test (`dispatch.test.ts`) before any live email send.
3. **Google OAuth verification.** Sending real Gmail at scale may require Google app verification for
   the `gmail.send` scope. Fine for your own/agreed test accounts now; flag before client rollout.
4. **Spoofable caller ID** (see §7) — optional PIN is the mitigation, pre-wired.
5. **Don't place real calls / send real email beyond agreed testing** — same hard rule as the rest of
   the repo; relay + email handlers gated behind a test-mode flag until you say go.

## 11. What I need from you to start the Cursor handoff

- ✅ Capabilities: CRM actions, send email, book appointments, relay call (all confirmed)
- ✅ Email: Gmail · Calendar: Google · Auth: phone allow-list
- ☐ Confirm the **agent name** (Atlas?) and which **Retell account/number** Atlas will answer on
- ☐ Confirm Google account(s) for the test owner + that you can create a Google Cloud OAuth client
- ☐ Accept this plan → I'll write the scoped `docs/cursor-handoff-owner-assistant.md` (same format as
  your existing handoffs) and we begin Phase 0.
```
