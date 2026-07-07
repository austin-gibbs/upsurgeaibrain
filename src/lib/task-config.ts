import type { StageMapEntry, TaskConfig } from "@/components/agent-form/types";
import { defaultTaskConfig } from "@/components/agent-form/types";
import { normalizeHHMM } from "@/lib/hhmm";

/** Trim strings and coerce blanks to null. */
function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalize task-config before PATCH so empty strings don't fail validation.
 */
export function prepareTaskConfigForSave(cfg: TaskConfig): TaskConfig {
  const opportunityId = trimOrNull(cfg.opportunity_custom_field_id);
  const opportunityValue = trimOrNull(cfg.opportunity_custom_field_value);
  const pollPipelineId = trimOrNull(cfg.poll_pipeline_id);
  const pollStageId = trimOrNull(cfg.poll_pipeline_stage_id);
  const webhookUrl = trimOrNull(cfg.post_call_webhook_url);

  return {
    ...cfg,
    due_at_time: cfg.due_at_time ? normalizeHHMM(cfg.due_at_time) : null,
    post_call_webhook_url: webhookUrl,
    poll_pipeline_id: pollPipelineId,
    poll_pipeline_stage_id: pollStageId,
    poll_stage_enabled: cfg.poll_stage_enabled,
    opportunity_custom_field_id: opportunityId,
    opportunity_custom_field_key: trimOrNull(cfg.opportunity_custom_field_key),
    opportunity_custom_field_label: trimOrNull(cfg.opportunity_custom_field_label),
    opportunity_custom_field_value: opportunityValue,
    opportunity_custom_field_value_label: trimOrNull(
      cfg.opportunity_custom_field_value_label
    ),
    opportunity_custom_field_enabled: cfg.opportunity_custom_field_enabled,
  };
}

/** Keep only routing rules with both pipeline and stage selected. */
export function prepareStageMapForSave(stageMap: StageMapEntry[]): StageMapEntry[] {
  return stageMap.filter(
    (rule) => rule.pipeline_id?.trim() && rule.pipeline_stage_id?.trim()
  );
}

/** Human-readable validation errors for incomplete task automation settings. */
export function validateTaskConfigForSave(cfg: TaskConfig): string | null {
  if (
    cfg.opportunity_custom_field_enabled &&
    (!cfg.opportunity_custom_field_id?.trim() || !cfg.opportunity_custom_field_value?.trim())
  ) {
    return "Select both an opportunity field and value, or turn off the opportunity custom field toggle.";
  }
  if (
    cfg.poll_stage_enabled &&
    (!cfg.poll_pipeline_id?.trim() || !cfg.poll_pipeline_stage_id?.trim())
  ) {
    return "Select both a poll pipeline and stage, or turn off poll-stage routing.";
  }
  if (cfg.post_call_webhook_enabled && !cfg.post_call_webhook_url?.trim()) {
    return "Enter a webhook URL, or turn off the post-call webhook toggle.";
  }
  return null;
}

export function validateStageMapForSave(
  stageMap: StageMapEntry[],
  pipelineAutomationEnabled: boolean
): string | null {
  if (!pipelineAutomationEnabled) return null;

  const incomplete = stageMap.filter((rule) => {
    const hasPipeline = Boolean(rule.pipeline_id?.trim());
    const hasStage = Boolean(rule.pipeline_stage_id?.trim());
    return hasPipeline !== hasStage;
  });
  if (incomplete.length > 0) {
    return "Each routing rule needs both a pipeline and stage selected (or remove the rule).";
  }

  const emptyRules = stageMap.filter(
    (rule) => !rule.pipeline_id?.trim() && !rule.pipeline_stage_id?.trim()
  );
  if (emptyRules.length > 0) {
    return "Remove empty routing rules or finish selecting a pipeline and stage for each one.";
  }

  return null;
}

/** Hydrate form state from an agent_task_configs row. */
export function taskConfigFromRow(row: Record<string, unknown> | null | undefined): TaskConfig {
  if (!row) return defaultTaskConfig();

  const str = (key: string): string | null => {
    const val = row[key];
    return typeof val === "string" && val.trim() ? val : null;
  };

  return {
    enabled: Boolean(row.enabled),
    name_template: str("name_template") ?? defaultTaskConfig().name_template,
    task_type: str("task_type") ?? "Follow Up",
    assignee_crm_id: str("assignee_crm_id"),
    assignee_label: str("assignee_label"),
    due_offset_minutes:
      typeof row.due_offset_minutes === "number" ? row.due_offset_minutes : 0,
    due_at_time: str("due_at_time"),
    min_duration_seconds:
      typeof row.min_duration_seconds === "number" ? row.min_duration_seconds : 0,
    only_outcomes: Array.isArray(row.only_outcomes)
      ? (row.only_outcomes as string[])
      : null,
    post_call_webhook_enabled: Boolean(row.post_call_webhook_enabled),
    post_call_webhook_url: str("post_call_webhook_url"),
    post_call_webhook_only_outcomes: Array.isArray(row.post_call_webhook_only_outcomes)
      ? (row.post_call_webhook_only_outcomes as string[])
      : null,
    pipeline_automation_enabled: Boolean(row.pipeline_automation_enabled),
    poll_stage_enabled: Boolean(row.poll_stage_enabled),
    poll_pipeline_id: str("poll_pipeline_id"),
    poll_pipeline_stage_id: str("poll_pipeline_stage_id"),
    poll_pipeline_name: str("poll_pipeline_name"),
    poll_stage_name: str("poll_stage_name"),
    opportunity_custom_field_enabled: Boolean(row.opportunity_custom_field_enabled),
    opportunity_custom_field_id: str("opportunity_custom_field_id"),
    opportunity_custom_field_key: str("opportunity_custom_field_key"),
    opportunity_custom_field_label: str("opportunity_custom_field_label"),
    opportunity_custom_field_value: str("opportunity_custom_field_value"),
    opportunity_custom_field_value_label: str("opportunity_custom_field_value_label"),
  };
}

export function stageMapFromRows(rows: Record<string, unknown>[]): StageMapEntry[] {
  return rows.map((m) => ({
    outcome: String(m.outcome ?? "no_answer_voicemail"),
    call_attempt: typeof m.call_attempt === "number" ? m.call_attempt : null,
    pipeline_id: String(m.pipeline_id ?? ""),
    pipeline_stage_id: String(m.pipeline_stage_id ?? ""),
    pipeline_name: typeof m.pipeline_name === "string" ? m.pipeline_name : null,
    stage_name: typeof m.stage_name === "string" ? m.stage_name : null,
  }));
}

/**
 * After PATCH, prefer the config we just submitted so the form never clears
 * when a server re-read omits newer columns.
 */
export function resolveTaskConfigAfterSave(
  serverRow: Record<string, unknown> | undefined,
  submitted: TaskConfig | undefined
): TaskConfig | null {
  if (submitted) return submitted;
  if (serverRow) return taskConfigFromRow(serverRow);
  return null;
}
