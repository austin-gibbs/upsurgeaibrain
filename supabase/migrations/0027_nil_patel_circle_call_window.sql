-- Nil Patel Realty — Circle Prospecting (Ava):
-- Keep the outbound call window aligned with the approved 1pm-7pm Eastern schedule.
UPDATE agent_call_configs
SET
  call_window_start = '13:00',
  call_window_end = '19:00',
  daily_run_at = '13:00',
  updated_at = now()
WHERE agent_id = 'fafbdf14-5a00-49e2-90ac-bb2064aa5d37'::uuid;
