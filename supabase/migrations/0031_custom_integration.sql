-- =====================================================================
-- Custom integration (e.g. "SellMyFISBO" in Lovable).
--
-- Lets an EXTERNAL app trigger outbound AI calls on demand and receive
-- post-call reports, WITHOUT going through the Follow Up Boss / HighLevel
-- poll-by-tag machinery. Everything here is additive; no existing FUB or
-- HighLevel code path reads these columns/tables or is affected.
-- =====================================================================

-- 1. New CRM provider value. `ADD VALUE` only adds the label; it is not USED
--    in this same migration (Postgres forbids using a freshly-added enum value
--    in the transaction that adds it). Idempotent + safe to re-run.
ALTER TYPE crm_provider ADD VALUE IF NOT EXISTS 'custom';

-- 2. Per-lead dynamic-variable overrides. The custom CRM adapter returns these
--    from getContactFieldValues(), so caller.ts injects them into the Retell
--    prompt as {{homeowner_name}}, {{agent_name}}, {{property_address}}, etc.
--    Null for every FUB/HighLevel contact — those paths never read it.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS dynamic_var_overrides jsonb;

-- 3. Inbound API keys for the on-demand "trigger a call" endpoint. The external
--    app authenticates with `Authorization: Bearer <token>`; we persist ONLY the
--    SHA-256 hash of the token. Each key maps to the workspace + outbound agent
--    that should place the call.
CREATE TABLE IF NOT EXISTS integration_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  token_hash   text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  label        text,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS integration_api_keys_workspace_idx
  ON integration_api_keys (workspace_id);

-- Service-role only. The trigger endpoint uses the service client and looks the
-- token up server-side; no end-user ever queries this table directly. RLS on
-- with no policies = deny all for anon/authenticated, service role bypasses.
ALTER TABLE integration_api_keys ENABLE ROW LEVEL SECURITY;
