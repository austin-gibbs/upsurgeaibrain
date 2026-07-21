# SellMyFISBO — Production Rollout Runbook

Ordered steps to take the `custom` integration live. The **workspace** and the **"Morgan"
Retell agent** are both created by ONE provisioning run (Phase 4) — that single command
creates the Retell agent, binds the number, creates the SellMyFISBO workspace, connects
them, and activates. Everything else sequences around it.

> All live-ops steps (migration, provisioning, key mint, calls) run on Austin's Mac or a
> deployed environment — the Cowork sandbox can't reach Retell/Supabase. Typecheck =
> `npm run typecheck`.

---

## Phase 0 — Prereqs (one-time)

- [ ] Cursor has committed the SellMyFISBO batch (custom integration + Diamond memory.ts fix)
      and removed the temp artifacts. `npm run typecheck` + `npm test` green.
- [ ] `.env.local` has: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
      `CREDENTIALS_ENCRYPTION_KEY`, `NEXT_PUBLIC_APP_URL` (= `https://upsurgeprosai.com`).
- [ ] Rotate the SellMyFISBO **Retell secret key** in the Retell dashboard (it was shared in
      plaintext during the build). Keep the fresh key local/gitignored only.

## Phase 1 — Database

- [ ] Apply `supabase/migrations/0031_custom_integration.sql` in the SellMyFISBO **prod**
      Supabase (adds `custom` enum value, `contacts.dynamic_var_overrides`,
      `integration_api_keys` table).
- [ ] Confirm the earlier `0022_backend_audit_indexes.sql` is applied.

## Phase 2 — Deploy the code

- [ ] Deploy the committed batch to Vercel (`upsurgeprosai.com`). The trigger endpoint
      `/api/integrations/custom/trigger-call` must exist in the deployed build BEFORE any
      test call, or Lovable's trigger 404s.

## Phase 3 — Fill the provisioning spec

Edit `scripts/provision-sellmyfisbo.example.json` — replace the CHANGE_ME fields:

- [ ] `ownerEmail` → Austin's UpSurge app login email (must have signed into the app once).
- [ ] `retell.apiKey` → confirm it's the correct current SellMyFISBO Retell **API** key.
- [ ] `workspace.crmCredentials.reportWebhookUrl` →
      `https://cape-lead-elite.lovable.app/api/public/hooks/upsurge-report`
- [ ] `workspace.crmCredentials.reportWebhookSecret` → the shared secret you'll ALSO set as
      Lovable's `UPSURGE_REPORT_SECRET`. Both sides must match for signature verification.

(Already correct in the spec: outbound, activate=true, number `+12394752578`,
crmProvider `custom`, Morgan prompt, the 4 extra post-call fields.)

## Phase 4 — Provision workspace + Retell agent (the core step)

- [ ] Dry-run validate:
      `npm run provision:agent -- --spec=./scripts/provision-sellmyfisbo.example.json --dry-run`
- [ ] Run for real (same command, no `--dry-run`).
- [ ] **Record the printed `workspaceId` and `agentId`** — needed in Phase 6.

This creates Retell agent "Morgan", binds `+1 239 475 2578`, creates the SellMyFISBO
`custom` workspace with the encrypted report-webhook credentials, connects them, activates.

## Phase 5 — Publish the Retell agent

- [ ] After provisioning (and any voice / turn-taking tweaks), POST `/publish-agent` in
      Retell. Without this, live calls ignore the config.

## Phase 6 — Mint the API key

- [ ] Run:
      ```
      npx tsx scripts/create-integration-api-key.ts \
        --workspace=<workspaceId from Phase 4> \
        --agent=<agentId from Phase 4> \
        --label="SellMyFISBO Lovable app"
      ```
- [ ] **Copy the printed `usk_…` token once** — only its SHA-256 hash is stored; it can't be
      recovered.

## Phase 7 — Wire Lovable secrets

In the cape-lead-elite Lovable project, set these three server-side secrets:

- [ ] `UPSURGE_APP_URL` = `https://upsurgeprosai.com`
- [ ] `UPSURGE_API_KEY` = the `usk_…` token from Phase 6
- [ ] `UPSURGE_REPORT_SECRET` = the same secret used in the spec's `reportWebhookSecret`

## Phase 8 — Test & verify (single agreed live call)

- [ ] Trigger one call to your OWN number via the "Add to AI Campaign" button.
- [ ] Confirm the call places, Morgan uses the injected lead + agent variables.
- [ ] Confirm the post-call report lands in Lovable's `ai_call_reports` / report view, and
      the `X-UpSurge-Signature` verifies (no 401).
- [ ] Confirm no FUB / HighLevel workspace changed behavior (poller, cadence, tags untouched).

---

## Rollback / safety notes

- The trigger endpoint uses `testMode: true` (bypasses enroll-tag + call-window) — it is an
  explicit on-demand dial, not a cadence dial. FUB/HighLevel code paths are never touched.
- If reports 401: check the shared secret matches on both sides and the app compares the bare
  hex HMAC (no `sha256=` prefix), length-guarded before `timingSafeEqual`.
- If the trigger 404s: the batch isn't deployed to `upsurgeprosai.com` yet (Phase 2).
