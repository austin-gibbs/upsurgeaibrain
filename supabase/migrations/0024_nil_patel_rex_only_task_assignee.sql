-- Nil Patel Realty — outbound Follow Up Boss AI call review tasks:
-- Route outbound call review tasks only to "REX - OPE MANG ISA Tracker"
-- (FUB user id 76). Inbound concierge assignment/task routing remains Nil + Jori.
UPDATE agent_task_configs atc
SET
  assignee_crm_id = '76',
  assignee_label = 'REX - OPE MANG ISA Tracker',
  updated_at = now()
FROM agents a
JOIN workspaces w ON w.id = a.workspace_id
WHERE atc.agent_id = a.id
  AND w.name ILIKE '%Nil Patel%'
  AND a.direction = 'outbound'
  AND (
    CASE
      WHEN w.crm_provider IS NOT NULL THEN w.crm_provider
      ELSE a.crm_provider
    END
  ) = 'followupboss';
