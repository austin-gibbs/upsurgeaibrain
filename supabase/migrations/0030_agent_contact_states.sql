-- Per-agent cadence state for shared CRM contacts.
--
-- A single CRM contact can carry multiple agent enroll tags in the same
-- workspace. The contacts row remains the shared identity/tag cache, while
-- call cadence and terminal state must be scoped to the agent that is calling.

create table if not exists agent_contact_states (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  attempt_count int not null default 0,
  last_called_on date,
  next_eligible_on date,
  is_terminal boolean not null default false,
  terminal_outcome call_outcome,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_contact_states_unique unique (agent_id, contact_id)
);

create index if not exists agent_contact_states_agent_eligible_idx
  on agent_contact_states (agent_id, is_terminal, next_eligible_on);

create trigger trg_agent_contact_states_updated before update on agent_contact_states
  for each row execute function set_updated_at();

alter table agent_contact_states enable row level security;

create policy "rw agent contact states" on agent_contact_states
  for all using (
    contact_id in (
      select contacts.id
      from contacts
      where contacts.workspace_id in (select user_workspace_ids())
    )
  )
  with check (
    contact_id in (
      select contacts.id
      from contacts
      where contacts.workspace_id in (select user_workspace_ids())
    )
  );

-- Backfill explicit per-agent history from actual calls. Do not copy the legacy
-- contacts.* cadence columns wholesale: those were workspace/contact-global and
-- are the bug this migration fixes when a contact enters a second agent flow.
with latest_completed as (
  select distinct on (c.agent_id, c.contact_id)
    c.agent_id,
    c.contact_id,
    c.outcome,
    c.completed_at,
    c.queued_at,
    c.attempt_number
  from calls c
  where c.contact_id is not null
    and c.status = 'completed'
  order by c.agent_id, c.contact_id, c.completed_at desc nulls last, c.queued_at desc
),
agent_contact_rollup as (
  select
    c.agent_id,
    c.contact_id,
    max(coalesce(c.attempt_number, 0)) as attempt_count,
    max((c.dialed_at at time zone w.timezone)::date) filter (where c.dialed_at is not null) as last_called_on
  from calls c
  join workspaces w on w.id = c.workspace_id
  where c.contact_id is not null
  group by c.agent_id, c.contact_id
)
insert into agent_contact_states (
  agent_id,
  contact_id,
  attempt_count,
  last_called_on,
  next_eligible_on,
  is_terminal,
  terminal_outcome
)
select
  r.agent_id,
  r.contact_id,
  r.attempt_count,
  r.last_called_on,
  case
    when lc.outcome in ('appointment', 'not_interested', 'dnd') then null
    when r.last_called_on is null then null
    else (
      r.last_called_on +
      greatest(
        coalesce(
          cfg.cadence_day_gaps[
            least(
              greatest(lc.attempt_number + 1, 1),
              coalesce(array_length(cfg.cadence_day_gaps, 1), 1)
            )
          ],
          1
        ),
        1
      )
    )
  end as next_eligible_on,
  coalesce(lc.outcome in ('appointment', 'not_interested', 'dnd'), false) as is_terminal,
  case
    when lc.outcome in ('appointment', 'not_interested', 'dnd') then lc.outcome
    else null
  end as terminal_outcome
from agent_contact_rollup r
left join latest_completed lc
  on lc.agent_id = r.agent_id
 and lc.contact_id = r.contact_id
left join agent_call_configs cfg
  on cfg.agent_id = r.agent_id
on conflict (agent_id, contact_id) do nothing;
