-- =====================================================================
-- HighLevel opportunity automation — poll-stage routing + custom fields.
--
-- Lets each outbound agent configure:
--   1. A pipeline stage to move opportunities into when a poll enqueues calls.
--   2. An opportunity custom-field dropdown value (e.g. "AI Agent") applied
--      on every app-driven opportunity create or stage update.
-- =====================================================================

alter table agent_task_configs
  add column if not exists poll_stage_enabled boolean not null default false,
  add column if not exists poll_pipeline_id text,
  add column if not exists poll_pipeline_stage_id text,
  add column if not exists poll_pipeline_name text,
  add column if not exists poll_stage_name text,
  add column if not exists opportunity_custom_field_enabled boolean not null default false,
  add column if not exists opportunity_custom_field_id text,
  add column if not exists opportunity_custom_field_key text,
  add column if not exists opportunity_custom_field_label text,
  add column if not exists opportunity_custom_field_value text,
  add column if not exists opportunity_custom_field_value_label text;

comment on column agent_task_configs.poll_stage_enabled is
  'When true (HighLevel only), move queued contacts'' opportunities to poll_pipeline_stage_id during poll.';

comment on column agent_task_configs.opportunity_custom_field_enabled is
  'When true (HighLevel only), set the configured opportunity custom-field dropdown on every app-driven opportunity create/update.';
