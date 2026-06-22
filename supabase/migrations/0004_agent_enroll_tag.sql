-- =====================================================================
-- Per-agent enrollment tag.
--
-- Each agent can own a disjoint CRM contact segment via its own enroll
-- tag. When null, the agent falls back to the workspace enroll_tag.
-- Existing agents are backfilled from their workspace tag.
-- =====================================================================

alter table agents add column enroll_tag text;

update agents a
set enroll_tag = w.enroll_tag
from workspaces w
where a.workspace_id = w.id
  and a.enroll_tag is null;

create unique index agents_workspace_enroll_tag_idx
  on agents (workspace_id, lower(enroll_tag))
  where enroll_tag is not null;
