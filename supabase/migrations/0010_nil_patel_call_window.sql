-- Nil Patel Realty: 1pm–7pm Eastern call window; poll fires at window open.
UPDATE agent_call_configs
SET
  call_window_start = '13:00',
  call_window_end = '19:00',
  daily_run_at = '13:00',
  updated_at = now()
WHERE agent_id IN (
  SELECT a.id
  FROM agents a
  JOIN workspaces w ON w.id = a.workspace_id
  WHERE w.name ILIKE '%Nil Patel%'
    AND a.direction = 'outbound'
);
