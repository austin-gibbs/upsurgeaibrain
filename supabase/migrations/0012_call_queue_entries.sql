-- Durable call queue visible in the Ops UI. Tracks contacts from enqueue
-- through dial until FUB writeback completes, then the row is removed.

create type call_queue_status as enum (
  'pending',    -- enqueued in BullMQ, not yet dialed
  'dialing',    -- Retell call placed, awaiting outcome webhook
  'completed',  -- transient — removed after FUB writeback
  'failed',
  'cancelled'
);

create table call_queue_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status call_queue_status not null default 'pending',
  queue_day date not null,
  position int not null default 1,
  scheduled_for timestamptz,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  call_id uuid references calls(id) on delete set null,
  bullmq_job_id text,
  error_message text,
  constraint call_queue_entries_day_unique unique (agent_id, contact_id, queue_day)
);

create index call_queue_workspace_active_idx
  on call_queue_entries (workspace_id, status, enqueued_at)
  where status in ('pending', 'dialing');

alter table call_queue_entries enable row level security;

create policy "rw call queue entries" on call_queue_entries
  for all using (workspace_id in (select user_workspace_ids()))
  with check (workspace_id in (select user_workspace_ids()));
