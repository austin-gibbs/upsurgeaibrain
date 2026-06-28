-- Backend audit (2026-06-27): hot-path indexes + dial idempotency guard.

-- Resolve any historical duplicate active-attempt rows before the unique index.
with ranked as (
  select id,
    row_number() over (
      partition by agent_id, contact_id, attempt_number
      order by (retell_call_id is not null) desc, coalesce(dialed_at, queued_at) asc, id asc
    ) as rn
  from calls
  where contact_id is not null
    and status in ('queued', 'dialing', 'completed')
)
update calls
set status = 'failed',
    error_message = 'deduped during migration 0022 — duplicate active attempt row'
where id in (select id from ranked where rn > 1);

-- Drain/watchdog: pending rows due by agent + scheduled_for.
create index if not exists call_queue_agent_pending_sched_idx
  on call_queue_entries (agent_id, status, scheduled_for)
  where status = 'pending';

-- Daily dial counts + recent-dial watchdog scans.
create index if not exists calls_agent_dialed_at_idx
  on calls (agent_id, dialed_at)
  where dialed_at is not null;

-- Belt-and-suspenders: at most one active live attempt per (agent, contact, attempt).
-- Test calls (contact_id is null) are excluded.
create unique index if not exists calls_one_active_attempt_per_contact
  on calls (agent_id, contact_id, attempt_number)
  where contact_id is not null
    and status in ('queued', 'dialing', 'completed');
