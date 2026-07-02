-- Engine liveness beyond the generic worker heartbeat.
-- Lets failover crons detect a zombie worker (heartbeat fresh but scheduler/poll path dead).

alter table engine_heartbeat
  add column if not exists scheduler_last_tick_at timestamptz,
  add column if not exists scheduler_last_enqueued_at timestamptz,
  add column if not exists poll_worker_last_seen_at timestamptz,
  add column if not exists call_worker_last_seen_at timestamptz,
  add column if not exists redis_last_ok_at timestamptz,
  add column if not exists redis_last_ok boolean;

comment on column engine_heartbeat.scheduler_last_tick_at is
  'Last time tickScheduler() ran (worker or external cron).';
comment on column engine_heartbeat.scheduler_last_enqueued_at is
  'Last time tickScheduler() enqueued at least one poll job.';
comment on column engine_heartbeat.poll_worker_last_seen_at is
  'Last time the BullMQ poll worker started a poll job.';
comment on column engine_heartbeat.call_worker_last_seen_at is
  'Last time the BullMQ call worker started a dial job.';
comment on column engine_heartbeat.redis_last_ok_at is
  'Last Redis queue health probe that succeeded.';
comment on column engine_heartbeat.redis_last_ok is
  'Result of the most recent Redis queue health probe.';
