-- =====================================================================
-- Upsurge Platform — initial schema
-- Multi-tenant AI voice-agent orchestration (Retell AI + FUB/HighLevel)
--
-- Tenancy model:
--   organization  = the agency (Upsurge, or any reseller)
--   workspace     = a single client of the agency (has ONE CRM)
--   agent         = a Retell AI voice agent inside a workspace
--   call config   = per-agent outbound dialing rules
--   contact       = a person cached from the client's CRM
--   call          = one dial attempt + its outcome
--   task          = a follow-up task created in the CRM after a call
--   agent_memory  = (V2) rolling per-contact memory injected into Retell
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type crm_provider as enum ('followupboss', 'highlevel');

create type member_role as enum ('owner', 'admin', 'member');

create type agent_status as enum ('draft', 'active', 'paused');

create type call_outcome as enum (
  'voicemail',
  'no_answer',
  'appointment',
  'not_interested',
  'dnd',
  'interested_no_appointment',
  'follow_up',
  'error'
);

create type call_status as enum (
  'queued',       -- enqueued in BullMQ, not yet dialed
  'dialing',      -- Retell call created
  'completed',    -- call_analyzed received + processed
  'failed'        -- could not place/process
);

-- ---------------------------------------------------------------------
-- profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- organizations (the agency)
-- ---------------------------------------------------------------------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now()
);

create table organization_members (
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  role member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- ---------------------------------------------------------------------
-- workspaces (one client)  — STEP 1 of the setup wizard
-- ---------------------------------------------------------------------
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  timezone text not null default 'America/New_York',
  crm_provider crm_provider not null,
  -- CRM auth + identifiers, encrypted application-side (see lib/crypto.ts).
  -- e.g. FUB: { api_key }, HighLevel: { access_token, location_id }
  crm_credentials_encrypted text,
  -- The CRM tag that marks a contact as enrolled in the call flow.
  enroll_tag text not null default 'upsurgecallflowai',
  is_active boolean not null default true,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workspaces_org_idx on workspaces (organization_id);

-- Per-workspace outcome tag taxonomy.  Defaults match the production n8n
-- system; terminal outcomes remove the contact from the call flow.
create table workspace_outcome_tags (
  workspace_id uuid not null references workspaces (id) on delete cascade,
  outcome call_outcome not null,
  tag text not null,
  is_terminal boolean not null default false,
  primary key (workspace_id, outcome)
);

-- ---------------------------------------------------------------------
-- agents (Retell AI voice agent)  — STEP 2 of the wizard
-- ---------------------------------------------------------------------
create table agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  name text not null,
  -- Retell linkage
  retell_agent_id text,
  retell_from_number text,            -- E.164 outbound caller ID
  -- The high-level objective the agent pursues every call (e.g. "book a
  -- listing appointment"). Carried into V2 memory so context persists.
  objective text,
  status agent_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agents_workspace_idx on agents (workspace_id);

-- Per-agent outbound dialing rules  — STEP 3 of the wizard
create table agent_call_configs (
  agent_id uuid primary key references agents (id) on delete cascade,
  -- Volume caps
  max_total_calls int,                 -- lifetime cap per contact (null = unlimited)
  max_calls_per_day int not null default 100,   -- workspace-wide daily dial cap for this agent
  max_attempts_per_contact int not null default 10,
  -- Daily call window (local to workspace timezone), 24h "HH:MM"
  call_window_start text not null default '09:00',
  call_window_end text not null default '18:00',
  -- Day this agent's daily poll fires, 24h "HH:MM" workspace-local
  daily_run_at text not null default '09:00',
  -- Seconds between consecutive dials (drip throttle). 60 = 1/min.
  drip_seconds int not null default 60,
  -- Variable cadence: days to wait before the next attempt, indexed by
  -- attempt number. e.g. [0,1,2,3,5,7,...]  attempt 1 = same day.
  cadence_day_gaps int[] not null default '{0,1,2,3,5,7,10,14,21,30}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Task-creation rule after each call  — STEP 4 of the wizard
create table agent_task_configs (
  agent_id uuid primary key references agents (id) on delete cascade,
  enabled boolean not null default false,
  -- Template; {contact_name} and {date} are substituted at runtime.
  name_template text not null default 'UpSurge AI Call Review for {contact_name} on {date}',
  task_type text not null default 'Follow Up',
  -- CRM user the task is assigned to (FUB numeric id or HighLevel user id).
  assignee_crm_id text,
  assignee_label text,
  -- Minutes after the call the task is due.
  due_offset_minutes int not null default 0,
  -- Only create a task for these outcomes (null = all outcomes).
  only_outcomes call_outcome[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- contacts (cached from CRM)
-- ---------------------------------------------------------------------
create table contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  crm_contact_id text not null,        -- id in FUB / HighLevel
  full_name text,
  phones text[] not null default '{}', -- E.164, in dial order
  -- Mirror of CRM tags at last sync; source of truth stays in the CRM.
  tags text[] not null default '{}',
  -- Cadence state (mirrors the n8n tag-state model, but typed).
  attempt_count int not null default 0,
  last_called_on date,                 -- workspace-local date of last dial
  next_eligible_on date,               -- earliest date for next dial
  is_terminal boolean not null default false,  -- removed from flow
  terminal_outcome call_outcome,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, crm_contact_id)
);

create index contacts_workspace_idx on contacts (workspace_id);
create index contacts_eligible_idx on contacts (workspace_id, is_terminal, next_eligible_on);

-- ---------------------------------------------------------------------
-- calls (one dial attempt)
-- ---------------------------------------------------------------------
create table calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  attempt_number int not null,
  to_number text not null,
  retell_call_id text,
  status call_status not null default 'queued',
  outcome call_outcome,
  -- Retell analysis artifacts
  in_voicemail boolean,
  summary text,
  transcript text,
  raw_payload jsonb,                   -- full Retell webhook body for audit
  applied_tag text,                    -- the outcome tag written to the CRM
  task_created boolean not null default false,
  error_message text,
  queued_at timestamptz not null default now(),
  dialed_at timestamptz,
  completed_at timestamptz
);

create index calls_workspace_idx on calls (workspace_id, queued_at desc);
create index calls_contact_idx on calls (contact_id, attempt_number);
create unique index calls_retell_id_idx on calls (retell_call_id) where retell_call_id is not null;

-- ---------------------------------------------------------------------
-- agent_memory (V2) — rolling per-contact memory injected into Retell
-- ---------------------------------------------------------------------
create table agent_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  agent_id uuid not null references agents (id) on delete cascade,
  contact_id uuid not null references contacts (id) on delete cascade,
  -- Natural-language memory the LLM compresses after every call. This is
  -- injected into Retell as a dynamic variable on the NEXT call so the
  -- agent continues the relationship instead of starting cold.
  summary text not null default '',
  -- Structured facts the agent extracted (preferences, objections,
  -- best-time-to-call, etc.) for precise prompt templating.
  facts jsonb not null default '{}'::jsonb,
  -- Running objective state (e.g. progress toward booking).
  objective_state jsonb not null default '{}'::jsonb,
  call_count int not null default 0,
  last_call_id uuid references calls (id),
  updated_at timestamptz not null default now(),
  unique (agent_id, contact_id)
);

create index agent_memory_contact_idx on agent_memory (contact_id);

-- ---------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_workspaces_updated before update on workspaces
  for each row execute function set_updated_at();
create trigger trg_agents_updated before update on agents
  for each row execute function set_updated_at();
create trigger trg_contacts_updated before update on contacts
  for each row execute function set_updated_at();
create trigger trg_agent_call_configs_updated before update on agent_call_configs
  for each row execute function set_updated_at();
create trigger trg_agent_task_configs_updated before update on agent_task_configs
  for each row execute function set_updated_at();
