-- Fixed task due time-of-day. When set (HH:MM in the workspace timezone), the
-- outcome processor pins each created CRM task to TODAY at this time instead of
-- using due_offset_minutes — letting a team require same-day completion (e.g.
-- "due today at 5am ET, even if already past"). NULL = keep offset behavior.
ALTER TABLE agent_task_configs
  ADD COLUMN IF NOT EXISTS due_at_time text;
