-- Nil Patel Realty — Circle Prospecting (Ava):
-- Open Sunday (ISO 7) and align the call window to 3pm–7pm Eastern so
-- scheduler + failover can poll during the approved Sunday window.
-- Canonical enroll tag remains agents.enroll_tag = upsurge.circleprospecting.ai.
UPDATE agent_call_configs
SET
  call_window_start = '15:00',
  call_window_end = '19:00',
  daily_run_at = '15:00',
  call_window_days = ARRAY[2, 3, 4, 5, 6, 7]::int[],
  updated_at = now()
WHERE agent_id = 'fafbdf14-5a00-49e2-90ac-bb2064aa5d37'::uuid;

UPDATE agents
SET
  enroll_tag = 'upsurge.circleprospecting.ai',
  updated_at = now()
WHERE id = 'fafbdf14-5a00-49e2-90ac-bb2064aa5d37'::uuid
  AND (enroll_tag IS DISTINCT FROM 'upsurge.circleprospecting.ai');
