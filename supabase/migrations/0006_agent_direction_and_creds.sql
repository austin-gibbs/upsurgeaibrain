-- =====================================================================
-- 0006 — Per-agent direction + per-agent CRM and Retell credentials.
--
-- An agent is now explicitly INBOUND or OUTBOUND, and that choice changes
-- how it is wired:
--   - outbound: the app dials enrolled contacts on a cadence
--               (needs retell_from_number + the agent_call_configs row).
--   - inbound:  the agent answers the business line and the inbound
--               processor documents the call (needs its own Retell creds).
--
-- CRM is also selectable per agent now. When an agent's crm_provider /
-- crm_credentials_encrypted are NULL it inherits the workspace-level CRM,
-- so existing outbound agents keep working untouched (back-compat).
-- =====================================================================

-- Direction --------------------------------------------------------------
alter table agents
  add column if not exists direction text not null default 'outbound';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agents_direction_chk'
  ) then
    alter table agents
      add constraint agents_direction_chk
      check (direction in ('inbound', 'outbound'));
  end if;
end $$;

create index if not exists agents_direction_idx on agents (workspace_id, direction);

-- Per-agent CRM (nullable → inherit workspace) ---------------------------
alter table agents
  add column if not exists crm_provider crm_provider;
alter table agents
  add column if not exists crm_credentials_encrypted text;

-- Per-agent Retell credentials, encrypted app-side (see lib/crypto.ts).
-- Shape: { apiKey, webhookSecret? }. Required for inbound agents.
alter table agents
  add column if not exists retell_credentials_encrypted text;
