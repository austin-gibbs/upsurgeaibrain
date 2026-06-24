-- =====================================================================
-- Optional call-attempt dimension on pipeline routing rules.
--
-- Rules can pin an exact call_attempt (e.g. no_answer + attempt 2 -> Day 2)
-- or leave call_attempt NULL as a catch-all for that outcome (e.g.
-- appointment -> Booked, any attempt). Engine prefers exact match, then
-- falls back to the NULL row.
-- =====================================================================

alter table agent_pipeline_stage_map
  add column if not exists call_attempt int;

alter table agent_pipeline_stage_map
  add column if not exists id uuid default gen_random_uuid();

update agent_pipeline_stage_map
set id = gen_random_uuid()
where id is null;

alter table agent_pipeline_stage_map
  alter column id set not null;

alter table agent_pipeline_stage_map
  drop constraint if exists agent_pipeline_stage_map_pkey;

alter table agent_pipeline_stage_map
  add primary key (id);

create unique index if not exists agent_pipeline_stage_map_agent_outcome_attempt_idx
  on agent_pipeline_stage_map (agent_id, outcome, coalesce(call_attempt, -1));

comment on column agent_pipeline_stage_map.call_attempt is
  'When set, rule applies only to this call attempt number. NULL = any attempt (fallback).';
