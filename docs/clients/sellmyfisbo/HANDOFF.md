# SellMyFISBO — Custom Integration Handoff

The third UpSurge integration: `custom`. It lets the external **SellMyFISBO** Lovable
app trigger outbound "Morgan" FSBO calls on demand and receive post-call reports —
**without touching the Follow Up Boss or HighLevel code paths**. Everything is additive.

> Runs that touch Retell or Supabase (provisioning, key minting, migration) must be
> executed on your Mac / a deployed environment — the Cowork sandbox can't reach them.
> All code below typechecks clean (`npm run typecheck`).

---

## How it works (one paragraph)

The Lovable app's "Add to AI Campaign" button POSTs the lead **and** the triggering
real-estate agent to UpSurge. UpSurge stashes the merged fields on a local `contacts`
row (`dynamic_var_overrides`) and places one Retell call immediately — the existing
`caller.ts` injects those fields as `{{homeowner_name}}`, `{{agent_name}}`, etc. The
poller never runs for this workspace (the custom CRM adapter's `getContactsByTag()`
returns `[]`), so these leads are only ever called by the button. When the call is
analyzed, `process-outcome.ts` POSTs a structured report back to the Lovable app.

---

## Go-live checklist (in order)

1. **Apply migrations** in the SellMyFISBO Supabase (prod):
   `0031_custom_integration.sql` (adds `custom` enum value, `contacts.dynamic_var_overrides`,
   `integration_api_keys` table). Also confirm the earlier `0022_backend_audit_indexes.sql`
   is applied.
2. **Env vars** (Vercel + worker): standard set + `PROVISION_API_KEY` (if using the admin
   endpoint), `CREDENTIALS_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` (so Retell webhooks point
   at the app). `.env.local` must have `SUPABASE_SERVICE_ROLE_KEY` for the scripts.
3. **Rotate the SellMyFISBO Retell secret key** — it was shared in plaintext during this
   build. Do this in the Retell dashboard, then use the fresh key in the spec.
4. **Provision the agent + workspace** (creates Retell agent "Morgan", binds number
   +1 239 475 2578, creates the `custom` workspace, activates):
   - Fill `scripts/provision-sellmyfisbo.example.json`: `ownerEmail`, `retell.apiKey`,
     and `workspace.crmCredentials.reportWebhookUrl` (the Lovable report endpoint).
   - Validate: `npm run provision:agent -- --spec=./scripts/provision-sellmyfisbo.example.json --dry-run`
   - Run for real: same command without `--dry-run`. Note the printed `workspaceId` + `agentId`.
5. **Publish the Retell agent** — after provisioning (and any voice/turn-taking tweaks),
   POST `/publish-agent` in Retell or live calls will ignore the config.
6. **Mint the API key** the Lovable app uses to trigger calls:
   ```
   npx tsx scripts/create-integration-api-key.ts \
     --workspace=<workspaceId from step 4> \
     --agent=<agentId from step 4> \
     --label="SellMyFISBO Lovable app"
   ```
   Copy the printed `usk_…` token **once** — only its SHA-256 hash is stored.
7. **Wire the Lovable app** to the two endpoints below, using that token.
8. **Test** one call to your own number (this is the only agreed live call), verify the
   report lands back in Lovable, and confirm no FUB/HighLevel workspaces changed behavior.

---

## API contract 1 — trigger a call (Lovable → UpSurge)

```
POST {NEXT_PUBLIC_APP_URL}/api/integrations/custom/trigger-call
Authorization: Bearer usk_…
Content-Type: application/json
```

Body:
```json
{
  "lead": {
    "id": "sellmyfisbo-lead-uuid",        // required, becomes contacts.crm_contact_id
    "phone": "+15551234567",               // required, E.164
    "name": "Pat",
    "email": "pat@example.com",
    "property_address": "123 Elm St",
    "property_city": "Naples",
    "listing_price": "$625,000",
    "days_on_market": "18"
  },
  "agent": {
    "name": "Jordan Rivera",               // required — the RE agent who clicked the button
    "company": "Coastal Realty",
    "phone": "+15559876543",
    "email": "jordan@coastalrealty.com"
  },
  "variables": {}                          // optional extra {{tokens}}, verbatim
}
```

Success `200`: `{ "ok": true, "callId", "retellCallId", "contactId", "leadId" }`.
Errors: `401` bad/missing token, `400` invalid payload, `409` agent misconfigured,
`502` call failed to place. Re-triggering the same `lead.id` reuses one contact row and
refreshes its dynamic variables.

The `lead.*` and `agent.*` fields map to these Retell dynamic variables:
`homeowner_name, property_address, property_city, listing_price, days_on_market,
agent_name, agent_company, agent_phone, agent_email`.

---

## API contract 2 — post-call report (UpSurge → Lovable)

UpSurge POSTs to your `reportWebhookUrl` after each call is analyzed. If you set
`reportWebhookSecret` in the spec, verify `X-UpSurge-Signature` = HMAC-SHA256(body).

```json
{
  "event": "call_completed",
  "workspace_id": "…", "agent_id": "…", "agent_name": "Morgan (SellMyFISBO FSBO Setter)",
  "call_id": "…", "retell_call_id": "…", "attempt_number": 1,
  "outcome": "appointment",
  "outcome_label": "Appointment",
  "lead_id": "sellmyfisbo-lead-uuid",
  "variables": { "homeowner_name": "Pat", "agent_name": "Jordan Rivera", "...": "..." },
  "fields": {
    "call_outcome": "appointment",
    "appointment_time": "Saturday afternoon",
    "seller_timeline": "60 days",
    "asking_price": "$625,000",
    "reason_for_selling": "relocating for work",
    "best_callback_time": ""
  },
  "summary": "…", "transcript": "…", "recording_url": "…",
  "call_date": "2026-07-20", "duration_seconds": 142
}
```

`outcome` is one of: `appointment`, `interested_no_appointment`, `follow_up`,
`not_interested`, `dnd`, `no_answer_voicemail`. The `fields` object contains the Retell
post-call analysis fields authored by the provisioning spec (`extraPostCallFields`).

---

## What changed in the repo (all additive)

- `supabase/migrations/0031_custom_integration.sql` — enum value, column, keys table.
- `src/lib/crm/custom.ts` + `types.ts` + `index.ts` — `CustomAdapter` (poller no-op,
  injects dynamic vars); `CustomCredentials { reportWebhookUrl, reportWebhookSecret? }`.
- `src/lib/integrations/custom/{api-key,report}.ts` — bearer auth + report dispatch.
- `src/app/api/integrations/custom/trigger-call/route.ts` — the trigger endpoint.
- `src/lib/engine/process-outcome.ts` — "4b-custom" block dispatches the report (non-fatal).
- `src/lib/engine/outcome.ts` — `extractFromRetellPayload` now returns `customFields`.
- `src/lib/provisioning/provision-agent.ts` — accepts `crmProvider: "custom"`,
  `CustomCredentials`, and `retell.extraPostCallFields` (appended to Retell defaults).
- `scripts/provision-sellmyfisbo.example.json` — the provisioning spec (fill CHANGE_ME).
- `scripts/create-integration-api-key.ts` — mints the Lovable bearer token.

The Follow Up Boss and HighLevel adapters, the poller, and the call-window logic are
untouched. The only shared change is `src/lib/engine/memory.ts`'s dynamic-variable map
(the Diamond HighLevel fix, adding `customer_name`/`first_name` and trimming
`contact_name`), which is additive and provider-agnostic.
