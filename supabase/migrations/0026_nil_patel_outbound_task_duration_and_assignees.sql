-- Nil Patel Realty — probate (Mia) and circle prospecting (Ava) outbound agents:
--   * Create separate FUB call review tasks for Nil (1), Jori (17), and Rex (76).
--   * Only create tasks when the outgoing call lasted >= 30 seconds.
-- Scoped to the two target agent rows only; other workspaces/agents unchanged.
UPDATE agent_task_configs
SET
  enabled = true,
  assignee_crm_id = '1,17,76',
  assignee_label = 'Nil Patel, Jori Garcia, REX - OPE MANG ISA Tracker',
  min_duration_seconds = 30,
  updated_at = now()
WHERE agent_id IN (
  '90a9c10c-77a3-470a-92bf-2eb874448d3f'::uuid,
  'fafbdf14-5a00-49e2-90ac-bb2064aa5d37'::uuid
);
