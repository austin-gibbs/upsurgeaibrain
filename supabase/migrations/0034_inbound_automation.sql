-- =====================================================================
-- 0034 — Productized inbound call automation (HighLevel).
--
-- Turns the one-client hardcoded inbound concierge into a config-driven
-- engine: after a Retell inbound agent answers, classify the call, resolve
-- or create the HighLevel contact by phone, apply tags, and create/update
-- the opportunity into a mapped pipeline stage.
--
-- Inbound outcomes are TEXT (validated in app code), deliberately NOT
-- extending the outbound call_outcome enum — that enum drives cadence
-- terminality and must not grow inbound-only values.
-- =====================================================================

-- Per-agent inbound automation config. Presence of the row + enabled=true
-- is the feature gate; absent/disabled agents keep the legacy FUB path.
create table if not exists agent_inbound_configs (
  agent_id uuid primary key references agents (id) on delete cascade,
  enabled boolean not null default false,
  create_contact_if_missing boolean not null default true,
  -- Applied on EVERY inbound call regardless of outcome.
  always_tag text,
  pipeline_automation_enabled boolean not null default false,
  default_pipeline_id text,
  default_pipeline_stage_id text,
  default_pipeline_name text,
  default_stage_name text,
  opportunity_name_template text not null default '{contact_name}',
  opportunity_custom_field_enabled boolean not null default false,
  opportunity_custom_field_id text,
  opportunity_custom_field_key text,
  opportunity_custom_field_value text,
  -- 'fixed' | 'dialed_line' | 'none'
  assignee_mode text not null default 'fixed',
  assignee_crm_id text,
  task_enabled boolean not null default false,
  task_name_template text not null default 'Follow up with {contact_name}',
  task_type text not null default 'Follow Up',
  task_due_offset_minutes int not null default 30,
  -- Suppress CRM writeback on hangups/misdials shorter than this.
  min_duration_seconds int not null default 0,
  new_contact_source text not null default 'AI Inbound Call',
  updated_at timestamptz not null default now()
);

comment on table agent_inbound_configs is
  'Per-agent inbound automation settings. enabled=false (or absent row) keeps the legacy inbound handler.';

comment on column agent_inbound_configs.always_tag is
  'Tag applied on every inbound call after it ends, regardless of classified outcome.';

comment on column agent_inbound_configs.assignee_mode is
  'fixed = use assignee_crm_id; dialed_line = map toNumber via inbound-routing; none = skip assign.';

alter table agent_inbound_configs enable row level security;

create policy "rw inbound configs" on agent_inbound_configs
  for all
  using (
    agent_id in (
      select id from agents where workspace_id in (select user_workspace_ids())
    )
  )
  with check (
    agent_id in (
      select id from agents where workspace_id in (select user_workspace_ids())
    )
  );

-- One row = one outcome → (stage, status, tag, remove_tags) rule.
-- outcome = '*' is the catch-all when no exact match exists.
create table if not exists agent_inbound_routes (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents (id) on delete cascade,
  outcome text not null,
  pipeline_id text,
  pipeline_stage_id text,
  pipeline_name text,
  stage_name text,
  -- open / won / lost / abandoned — passed to HighLevel MoveStageInput.status
  opportunity_status text,
  tag text,
  remove_tags text[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (agent_id, outcome)
);

comment on table agent_inbound_routes is
  'Inbound outcome → pipeline stage + tag routing rules. outcome=* is the catch-all.';

alter table agent_inbound_routes enable row level security;

create policy "rw inbound routes" on agent_inbound_routes
  for all
  using (
    agent_id in (
      select id from agents where workspace_id in (select user_workspace_ids())
    )
  )
  with check (
    agent_id in (
      select id from agents where workspace_id in (select user_workspace_ids())
    )
  );

-- Audit trail on the calls row for inbound automation.
alter table calls
  add column if not exists inbound_outcome text,
  add column if not exists inbound_route_id uuid,
  add column if not exists opportunity_id text;

comment on column calls.inbound_outcome is
  'Classified inbound outcome slug (text). Leaves the outbound call_outcome enum null for inbound rows.';

comment on column calls.inbound_route_id is
  'agent_inbound_routes.id that fired for this call, when a rule matched.';

comment on column calls.opportunity_id is
  'HighLevel opportunity id created or updated by inbound/outbound pipeline routing.';

create index if not exists calls_inbound_agent_idx
  on calls (agent_id, direction, completed_at desc);
