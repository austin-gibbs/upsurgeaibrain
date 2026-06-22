# PR: Inbound/Outbound Agents + Per-Agent Credentials

## Summary

Finishes wiring the inbound/outbound agent direction feature and per-agent CRM + Retell credentials. Agents can now be explicitly **inbound** (answers the line, documents to CRM) or **outbound** (dials enrolled contacts on a cadence). Each agent may carry its own encrypted CRM and Retell credentials; when CRM creds are null the agent inherits the workspace CRM.

## Changes

### Schema (migrations — apply before deploy)

Apply in order against the Supabase project:

1. `supabase/migrations/0005_inbound_calls.sql` — nullable `calls.contact_id`, `calls.direction`
2. `supabase/migrations/0006_agent_direction_and_creds.sql` — `agents.direction`, per-agent CRM + Retell credential columns

**Note:** Apply migrations using any of these (pick one):

```bash
# Option A — Management API (add SUPABASE_ACCESS_TOKEN to .env.local first)
npm run db:apply-pending

# Option B — Supabase CLI (after `npx supabase login && npx supabase link`)
npx supabase db query -f scripts/apply-pending-migrations.sql --linked

# Option C — paste scripts/apply-pending-migrations.sql into Supabase SQL Editor
```

### Types

- Updated [`src/types/database.ts`](src/types/database.ts) to reflect 0005/0006 (agents + calls columns)
- Removed all `as never` casts from agent insert and inbound call insert/update
- Extended domain `Call` type with nullable `contact_id` and `direction`

### Per-agent Retell webhook verification (Task 2)

- [`src/lib/retell/client.ts`](src/lib/retell/client.ts): `getRetellWebhookSecretForAgent`, multi-secret `verifyRetellSignature` (evaluates all candidates without short-circuiting)
- [`src/app/api/webhooks/retell/route.ts`](src/app/api/webhooks/retell/route.ts): resolves agent from `call.agent_id`, tries per-agent secret then env fallback

### Per-agent Retell API key for outbound dialing (Task 3)

- [`src/lib/retell/client.ts`](src/lib/retell/client.ts): `getRetellClientForAgent` (decrypts agent creds or falls back to `RETELL_API_KEY`)
- [`src/lib/engine/caller.ts`](src/lib/engine/caller.ts): uses `getRetellClientForAgent(agent)` in `placeCall()`

### Edit existing agents (Task 4)

- [`src/app/api/agents/[id]/route.ts`](src/app/api/agents/[id]/route.ts): GET returns `direction`, `enroll_tag`, `crm_provider`, `has_crm_credentials`, `has_retell_credentials` (never decrypted secrets). PATCH accepts direction + creds; blank credential fields preserve existing encrypted values.
- [`src/app/agents/[id]/page.tsx`](src/app/agents/[id]/page.tsx): direction toggle, CRM + Retell credential sections with "leave blank to keep current"

## Deferred

- Live Supabase migration apply (blocked on MCP; manual step required)
- Automated tests (out of scope for this PR)

## Task 5 — Manual verification runbook

### Prerequisites

Confirm `.env.local` has:

- `CREDENTIALS_ENCRYPTION_KEY` (base64 → 32 bytes: `openssl rand -base64 32`)
- `RETELL_API_KEY`, `RETELL_WEBHOOK_SECRET`
- Supabase URL/keys, `REDIS_URL`
- `NEXT_PUBLIC_APP_URL` pointing at the deployed app (Retell webhook target)

Apply migrations 0005 + 0006 to Supabase before testing.

Run both processes: `npm run dev` and `npm run worker`.

### 1. Create agents via UI

1. Open workspace → **Add agent**
2. Create one **outbound** agent: enroll tag, from-number, CRM creds
3. Create one **inbound** agent: Retell agent ID + Retell API key (+ webhook secret), CRM creds
4. In browser DevTools Network tab, confirm API responses never include decrypted keys
5. In Supabase `agents` table, confirm `direction`, `crm_credentials_encrypted`, `retell_credentials_encrypted` are populated

### 2. Edit flow

1. Open each agent detail page
2. Confirm direction badge, CRM provider, "Credentials stored (encrypted)" indicators
3. Update CRM provider without re-entering keys → should preserve existing creds
4. Update Retell webhook secret on inbound agent → save → replay webhook (step 3b)

### 3. Inbound test call

Follow [`docs/retell-inbound-concierge.md`](docs/retell-inbound-concierge.md):

1. Bind business inbound number to the Retell inbound agent
2. Global webhook → `{NEXT_PUBLIC_APP_URL}/api/webhooks/retell`
3. Place **one agreed test call**
4. Verify in Follow Up Boss:
   - Contact resolved/created by phone
   - Call logged with recording
   - Email Summary note format
   - Tags: `Priority: …`, `Call Type: …`
   - Lead assigned to Nil
   - Tasks: `New Lead | {Full Name}` for Nil and Jori
5. **Idempotency:** replay the same `call_analyzed` webhook payload → no duplicate `calls` row
6. **Per-agent secret:** confirm webhook verifies with the inbound agent's stored webhook secret (remove env secret temporarily to isolate, if desired)

### 4. Outbound test dial

1. Enroll a test contact with the outbound agent's enroll tag
2. Use a test number only
3. Trigger poll/dial (activate agent, wait for scheduler or manual poll)
4. Confirm dial uses per-agent Retell key if configured (check Retell dashboard call metadata)
5. Confirm `calls` row: `queued` → `dialing` → `completed` after webhook

### 5. Typecheck

```bash
npm run typecheck
```

Expected: clean (no errors).
