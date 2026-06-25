# Multi-Agent Contact Cadence — Decision

_Last updated: 2026-06-25._

## Context

The `contacts` table is **workspace-scoped**: one row per CRM contact (`workspace_id` +
`crm_contact_id`). Cadence fields (`attempt_count`, `last_called_on`, `next_eligible_on`,
`is_terminal`, `terminal_outcome`) are shared across all outbound agents in that workspace.

## Decision for Diamond Group Realty (and similar setups)

**Do not add `agent_contact_state` yet.**

For workspaces where each outbound agent uses a **disjoint enrollment tag**, contacts
should not be enrolled in two flows at once. Shared cadence state is acceptable and
matches how n8n operated (one contact, one active outbound path).

Requirements to keep this safe:

1. **One workspace-owned HighLevel connection** — agents inherit workspace CRM credentials;
   do not OAuth-connect multiple agents to the same HighLevel location (refresh token
   rotation de-auths siblings).
2. **Unique effective enroll tags** — enforced at provision, add-agent, edit, and
   activation (see `src/lib/agents/enroll-tag.ts`).
3. **Manual ops guardrails** — queue-now and test-call actions verify the contact carries
   the selected agent's enroll tag before dialing.

## When to add `agent_contact_state`

Add a migration keyed by `(agent_id, contact_id)` **only if** the product must support:

- The same HighLevel contact enrolled in **two outbound agents simultaneously** with
  independent attempt counts and next-eligible dates, or
- Overlapping enroll tags by design.

### Planned migration shape (not implemented)

```sql
create table agent_contact_state (
  agent_id uuid not null references agents(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  attempt_count int not null default 0,
  last_called_on date,
  next_eligible_on date,
  is_terminal boolean not null default false,
  terminal_outcome call_outcome,
  primary key (agent_id, contact_id)
);
```

Engine touchpoints: `poller.ts`, `caller.ts`, `process-outcome.ts`, sweeper, and Ops
projections would read/write agent-scoped state instead of `contacts.*` cadence columns.

## Diamond CRM inheritance note

Diamond Group Realty currently stores HighLevel credentials at **both** the workspace and
on `AI Agent | Seller Outgoing`. Seller Outgoing should **inherit the workspace
connection** (clear per-agent CRM credentials via agent settings → “Use workspace
connection”) so only one OAuth refresh chain exists for the same location.

Run `node scripts/audit-workspace-crm-inheritance.mjs [workspaceId]` to audit agents in
any workspace.
