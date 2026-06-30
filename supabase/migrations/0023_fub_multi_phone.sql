-- FUB multi-phone attempts: one cadence attempt may dial every normalized phone
-- on a contact in sequence. HighLevel and legacy rows keep phone_index = 0.

alter table calls
  add column if not exists phone_index int not null default 0,
  add column if not exists phone_count int not null default 1;

alter table call_queue_entries
  add column if not exists attempt_number int,
  add column if not exists phone_numbers text[] not null default '{}',
  add column if not exists next_phone_index int not null default 0;

-- Backfill queue rows so pending/dialing attempts survive deploy.
update call_queue_entries cqe
set
  attempt_number = coalesce(c.attempt_count, 0) + 1,
  phone_numbers = case
    when cardinality(c.phones) > 0 then c.phones
    else '{}'::text[]
  end,
  next_phone_index = 0
from contacts c
where cqe.contact_id = c.id
  and cqe.attempt_number is null;

update call_queue_entries
set attempt_number = 1
where attempt_number is null;

alter table call_queue_entries
  alter column attempt_number set not null;

-- Replace single-call-per-attempt guard with per-phone guard.
drop index if exists calls_one_active_attempt_per_contact;

with ranked as (
  select id,
    row_number() over (
      partition by agent_id, contact_id, attempt_number, phone_index
      order by (retell_call_id is not null) desc, coalesce(dialed_at, queued_at) asc, id asc
    ) as rn
  from calls
  where contact_id is not null
    and status in ('queued', 'dialing', 'completed')
)
update calls
set status = 'failed',
    error_message = 'deduped during migration 0023 — duplicate active phone attempt row'
where id in (select id from ranked where rn > 1);

create unique index if not exists calls_one_active_attempt_per_phone
  on calls (agent_id, contact_id, attempt_number, phone_index)
  where contact_id is not null
    and status in ('queued', 'dialing', 'completed');
