-- Singleton heartbeat row written by the Railway worker every ~30s.
-- Vercel failover crons read last_seen_at to decide whether to take over dialing.

create table engine_heartbeat (
  id text primary key default 'worker',
  last_seen_at timestamptz not null default now()
);

insert into engine_heartbeat (id, last_seen_at)
values ('worker', now())
on conflict (id) do nothing;

-- Service role only — workers and cron routes use createServiceClient().
alter table engine_heartbeat enable row level security;
