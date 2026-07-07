-- Optional minimum call duration (seconds) before post-call CRM tasks are created.
-- Default 0 preserves existing behavior for all agents/workspaces.
alter table agent_task_configs
  add column if not exists min_duration_seconds int not null default 0;

comment on column agent_task_configs.min_duration_seconds is
  'When > 0, create CRM tasks only when call duration is >= this many seconds.';
