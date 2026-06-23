-- =====================================================================
-- App-driven HighLevel pipeline routing.
--
-- Lets UpSurge move a contact's opportunity to a chosen pipeline stage
-- based on the classified call outcome — WITHOUT building a HighLevel
-- workflow per client. The mapping (outcome -> pipeline + stage) is data
-- the user sets once per agent in the UpSurge agent form; the engine then
-- calls the HighLevel Opportunities API directly after each call.
-- =====================================================================

-- Per-agent feature toggle, alongside the existing post-call webhook flag.
alter table agent_task_configs
  add column if not exists pipeline_automation_enabled boolean not null default false;

comment on column agent_task_configs.pipeline_automation_enabled is
  'When true (HighLevel only), move the contact''s opportunity to the mapped pipeline stage after each call.';

-- One row per (agent, outcome). Absent row = "no move" for that outcome.
-- pipeline_name / stage_name are display-label caches so the UI can render
-- the current selection without re-fetching pipelines from HighLevel.
create table if not exists agent_pipeline_stage_map (
  agent_id uuid not null references agents (id) on delete cascade,
  outcome call_outcome not null,
  pipeline_id text not null,
  pipeline_stage_id text not null,
  pipeline_name text,
  stage_name text,
  updated_at timestamptz not null default now(),
  primary key (agent_id, outcome)
);

alter table agent_pipeline_stage_map enable row level security;

-- Same scoping as task configs: a user can manage the map for any agent in
-- a workspace they belong to. The service role (engine) bypasses RLS.
create policy "rw pipeline stage map" on agent_pipeline_stage_map
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
