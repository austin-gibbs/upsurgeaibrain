-- Combined pending migrations for inbound/outbound agents feature.
-- Apply once in Supabase Dashboard → SQL Editor (or via psql with DATABASE_URL).
-- Order: 0005 then 0006.

-- =====================================================================
-- 0005 — Inbound call support
-- =====================================================================
alter table calls alter column contact_id drop not null;

alter table calls add column if not exists direction text not null default 'outbound';

create index if not exists calls_direction_idx on calls (workspace_id, direction, completed_at desc);

-- =====================================================================
-- 0006 — Per-agent direction + per-agent CRM and Retell credentials
-- =====================================================================
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

alter table agents
  add column if not exists crm_provider crm_provider;
alter table agents
  add column if not exists crm_credentials_encrypted text;

alter table agents
  add column if not exists retell_credentials_encrypted text;
