-- =====================================================================
-- Migrate data to no_answer_voicemail and merge workspace taxonomy.
-- Requires 0015_add_no_answer_voicemail_enum (enum value committed first).
-- =====================================================================

update agent_pipeline_stage_map
set outcome = 'no_answer_voicemail'
where outcome in ('voicemail', 'no_answer');

update calls
set outcome = 'no_answer_voicemail'
where outcome in ('voicemail', 'no_answer');

insert into workspace_outcome_tags (workspace_id, outcome, tag, is_terminal)
select
  workspace_id,
  'no_answer_voicemail'::call_outcome,
  coalesce(
    max(tag) filter (where outcome = 'no_answer'),
    max(tag) filter (where outcome = 'voicemail'),
    'upsurge-noanswer-voicemail-ai'
  ),
  false
from workspace_outcome_tags
where outcome in ('voicemail', 'no_answer')
group by workspace_id
on conflict (workspace_id, outcome) do nothing;

delete from workspace_outcome_tags
where outcome in ('voicemail', 'no_answer');

update agent_task_configs
set only_outcomes = (
  select coalesce(array_agg(distinct mapped), '{}'::call_outcome[])
  from (
    select case
      when x in ('voicemail', 'no_answer') then 'no_answer_voicemail'::call_outcome
      else x
    end as mapped
    from unnest(only_outcomes) as x
  ) s
)
where only_outcomes && array['voicemail', 'no_answer']::call_outcome[];

update agent_task_configs
set post_call_webhook_only_outcomes = (
  select coalesce(array_agg(distinct mapped), '{}'::call_outcome[])
  from (
    select case
      when x in ('voicemail', 'no_answer') then 'no_answer_voicemail'::call_outcome
      else x
    end as mapped
    from unnest(post_call_webhook_only_outcomes) as x
  ) s
)
where post_call_webhook_only_outcomes && array['voicemail', 'no_answer']::call_outcome[];

create or replace function seed_default_outcome_tags(p_workspace_id uuid)
returns void language plpgsql as $$
begin
  insert into workspace_outcome_tags (workspace_id, outcome, tag, is_terminal) values
    (p_workspace_id, 'no_answer_voicemail',       'upsurge-noanswer-voicemail-ai',     false),
    (p_workspace_id, 'appointment',               'upsurge-appointment-ai',          true),
    (p_workspace_id, 'not_interested',            'upsurge-notinterested-ai',        true),
    (p_workspace_id, 'dnd',                        'upsurge-dnd-ai',                  true),
    (p_workspace_id, 'interested_no_appointment',  'upsurge-interestednoappointment-ai', false),
    (p_workspace_id, 'follow_up',                  'upsurge-followup-ai',             false)
  on conflict (workspace_id, outcome) do nothing;
end;
$$;
