-- Combined pending migrations (0004–0008).
-- Apply once in Supabase Dashboard → SQL Editor (or via npm run db:apply-pending).
-- All statements use IF NOT EXISTS / idempotent patterns where possible.

-- =====================================================================
-- 0004 — Per-agent enrollment tag
-- =====================================================================
alter table agents add column if not exists enroll_tag text;

update agents a
set enroll_tag = w.enroll_tag
from workspaces w
where a.workspace_id = w.id
  and a.enroll_tag is null;

create unique index if not exists agents_workspace_enroll_tag_idx
  on agents (workspace_id, lower(enroll_tag))
  where enroll_tag is not null;

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

-- =====================================================================
-- 0007 — Reporting dashboard fields
-- =====================================================================
alter table workspaces
  add column if not exists crm_account_url text;

comment on column workspaces.crm_account_url is
  'Base URL for CRM contact pages, e.g. https://nilpatel.followupboss.com';

alter table contacts
  add column if not exists email text;

alter table calls
  add column if not exists crm_contact_id text,
  add column if not exists contact_name text,
  add column if not exists contact_email text;

create index if not exists calls_workspace_completed_idx
  on calls (workspace_id, completed_at desc nulls last);

create index if not exists calls_retell_lookup_idx
  on calls (retell_call_id)
  where retell_call_id is not null;

-- =====================================================================
-- 0008 — HighLevel post-call workflow webhook
-- =====================================================================
alter table agent_task_configs
  add column if not exists post_call_webhook_enabled boolean not null default false,
  add column if not exists post_call_webhook_url text,
  add column if not exists post_call_webhook_only_outcomes call_outcome[];

comment on column agent_task_configs.post_call_webhook_url is
  'HighLevel Workflow Inbound Webhook URL — receives call outcome JSON after each call.';
