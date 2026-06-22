# Cursor Handoff — Inbound/Outbound Agents + Per-Agent Credentials

Paste everything below this line into Cursor as the task brief. It is self-contained and scoped
**only** to the inbound/outbound agent feature and its per-agent credentials. Do not take on
unrelated cleanup, refactors, or parity work.

---

## Context

This is **UpSurge**, a Next.js (App Router) app that runs Retell AI voice agents driven off a CRM
(Follow Up Boss or HighLevel). Two processes run: `npm run dev` (Next.js UI/API) and
`npm run worker` (BullMQ workers + scheduler). Validate with `npm run typecheck`.

We just added two capabilities and need you to finish wiring them, apply the schema changes, and
stand the feature up end-to-end:

1. **Agent direction** — every agent is now explicitly **inbound** or **outbound**, which changes
   how it's set up. Outbound dials enrolled contacts on a cadence. Inbound answers the business
   line; the call is documented into the CRM and the team is notified (no dialing/enrollment).
2. **Per-agent credentials** — each agent now carries its own CRM provider + credentials, and
   inbound agents also carry their own Retell credentials. Both are encrypted at rest. When an
   agent's CRM creds are null it inherits the workspace-level CRM (back-compat).

The inbound Call Concierge ("Mia") setup is documented in `docs/retell-inbound-concierge.md`.

## Hard rules (do not violate)

- **Never expose, log, or commit the Follow Up Boss API key, Retell keys, or any secret.** All
  credentials are encrypted at rest via `src/lib/crypto.ts` (AES-256-GCM). `.env.local` is
  gitignored — keep it that way. Never return decrypted secrets to the client.
- **Austin is NOT the FUB account owner → no custom fields.** Contact state is modeled with tags.
- **Do not place real outbound calls** beyond explicitly agreed testing. Use Retell test mode / a
  test number for any live dial.
- **Stay in scope.** Only touch the inbound/outbound + per-agent-credentials feature.

## What's already implemented (read these first — do not redo)

- `supabase/migrations/0006_agent_direction_and_creds.sql` — adds to `agents`: `direction`
  (text, default `'outbound'`, CHECK in `('inbound','outbound')`), `crm_provider` (nullable enum),
  `crm_credentials_encrypted` (text), `retell_credentials_encrypted` (text), `agents_direction_idx`.
- `src/types/index.ts` — `AgentDirection`; `Agent` extended with the four new fields.
- `src/lib/validation.ts` — `retellCredentialsSchema`; `agentSchema` gained `direction`,
  `crm_provider`, `crm_credentials`, `retell_credentials`; `createAgentSchema` is a `superRefine`
  that requires a CRM choice + matching creds, an enroll tag for outbound, and a Retell agent id +
  Retell creds for inbound.
- `src/app/api/workspaces/[id]/agents/route.ts` — encrypts CRM + Retell creds, persists the new
  columns, skips enroll-tag uniqueness for inbound. (Insert is cast `as never` because the generated
  Supabase types lag migration 0006 — see Task 1.)
- `src/lib/crm/index.ts` — `getCrmAdapterForAgent(agent, workspace)` prefers per-agent CRM creds,
  falls back to workspace. The engine (`poller.ts`, `caller.ts`, `process-outcome.ts`,
  `process-inbound.ts`) resolves the adapter through it.
- `src/app/workspaces/[id]/agents/new/page.tsx` — new-agent form with the inbound/outbound toggle,
  CRM provider picker + credential inputs, a Retell-credentials section for inbound, and the
  outbound-only cadence/task settings.

`npm run typecheck` is currently clean.

## Your tasks (scoped to this feature only)

### 1. Apply schema + regenerate types (do this first)
- Apply migrations `0005_inbound_calls.sql` and `0006_agent_direction_and_creds.sql` in order to the
  Supabase project (and any branch/staging DB).
- Regenerate the Supabase generated types so `agents` (and `calls`) reflect the new/nullable columns.
- **Remove the `as never` casts** in `src/app/api/workspaces/[id]/agents/route.ts` (agents insert)
  and `src/lib/engine/process-inbound.ts` (calls insert/update) once the regenerated types make them
  type-safe. Replace with properly typed payloads. Keep `npm run typecheck` clean.

### 2. Per-agent Retell webhook verification (inbound)
Today `verifyRetellSignature` in `src/lib/retell/client.ts` only uses the account-wide
`RETELL_WEBHOOK_SECRET`. Inbound agents now store their own encrypted Retell creds
(`{ apiKey, webhookSecret? }`). Make inbound webhook verification accept the per-agent webhook
secret:
- Entry point is `src/app/api/webhooks/retell/route.ts`. The agent is resolved from the payload
  (`call.agent_id` → `agents.retell_agent_id`). Verify against the per-agent secret (decrypted) and
  fall back to the env secret. Keep it constant-time; don't leak which secret matched.
- Outbound continues to use the env secret. Do not break existing outbound verification.

### 3. Per-agent Retell API key for outbound dialing
`RetellClient` is constructed with `process.env.RETELL_API_KEY`. For agents that carry their own
Retell creds, `caller.ts placeCall()` should construct `RetellClient` with the agent's decrypted
Retell API key, falling back to the env key when the agent has none. Add a small helper (mirroring
`getCrmAdapterForAgent`) so this resolution lives in one place. Keep env fallback.

### 4. Edit existing agents (so direction + creds are manageable)
The agent edit/detail flow (`src/app/agents/[id]` + `PATCH /api/agents/[id]`) doesn't expose
direction or the per-agent credentials. Add the ability to view/update them, re-encrypting on change
and never returning decrypted secrets to the client. If a field is left blank on edit, keep the
existing stored secret rather than overwriting it with empty.

### 5. Stand it up end-to-end (manual verification)
- Confirm env vars are set: `CREDENTIALS_ENCRYPTION_KEY` (base64 → 32 bytes), `RETELL_API_KEY`,
  `RETELL_WEBHOOK_SECRET`, Supabase + Redis vars. Update `.env.example` if you add any.
- Create one **outbound** and one **inbound** agent through the new form; verify both persist with
  encrypted creds and the correct `direction`. Confirm decrypted secrets never reach the client.
- Inbound: follow `docs/retell-inbound-concierge.md` to bind a number + agent, place one agreed test
  call, and verify in FUB — contact resolved/created, call logged with recording, Email Summary
  note, `Priority:`/`Call Type:` tags, lead assigned to Nil, and "New Lead | {Full Name}" tasks for
  Nil and Jori. Replay the webhook to confirm idempotency (no duplicate `calls` row). Confirm the
  per-agent webhook secret (Task 2) verifies the inbound call.
- Outbound: with a test contact + test number, confirm a dial fires using the per-agent Retell key
  (Task 3) and the call row transitions queued → dialing → completed on the webhook.

## Deliverable

A PR (or clean commits) that applies the migrations, removes the `as never` casts after type regen,
implements tasks 2–4, and keeps `npm run typecheck` clean. In the PR description, note anything
deferred and how to run the Task 5 verification steps.
