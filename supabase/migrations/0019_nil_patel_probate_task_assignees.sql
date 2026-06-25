-- Nil Patel Realty — Probate AI Agent post-call FUB tasks:
--   * Add team member "REX - OPE MANG ISA Tracker" (FUB user id 76) as an
--     additional task assignee, alongside Nil Patel (1) and Jori Garcia (17).
--     The outcome processor creates one task per comma-separated assignee id.
--   * Pin every task's due date to TODAY @ 05:00 America/New_York (even if that
--     time has already passed) so the team completes them same-day.
UPDATE agent_task_configs
SET
  assignee_crm_id = '1,17,76',
  assignee_label = 'Nil Patel, Jori Garcia, REX - OPE MANG ISA Tracker',
  due_at_time = '05:00',
  updated_at = now()
WHERE agent_id IN (
  SELECT a.id
  FROM agents a
  JOIN workspaces w ON w.id = a.workspace_id
  WHERE w.name ILIKE '%Nil Patel%'
    AND a.direction = 'outbound'
    AND a.name ILIKE '%probate%'
);
