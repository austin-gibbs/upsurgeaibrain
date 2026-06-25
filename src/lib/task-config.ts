import type { TaskConfig } from "@/components/agent-form/types";
import { normalizeHHMM } from "@/lib/hhmm";

/** Trim strings and coerce blanks to null. */
function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Normalize task-config before PATCH so enabled flags match the fields the
 * user actually configured, and empty strings don't fail validation.
 */
export function prepareTaskConfigForSave(cfg: TaskConfig): TaskConfig {
  const opportunityId = trimOrNull(cfg.opportunity_custom_field_id);
  const opportunityValue = trimOrNull(cfg.opportunity_custom_field_value);
  const pollPipelineId = trimOrNull(cfg.poll_pipeline_id);
  const pollStageId = trimOrNull(cfg.poll_pipeline_stage_id);
  const webhookUrl = trimOrNull(cfg.post_call_webhook_url);

  let opportunity_custom_field_enabled = cfg.opportunity_custom_field_enabled;
  if (opportunityId && opportunityValue) {
    opportunity_custom_field_enabled = true;
  } else if (opportunity_custom_field_enabled && (!opportunityId || !opportunityValue)) {
    // Checked the box but didn't finish configuring — don't block the rest of the save.
    opportunity_custom_field_enabled = false;
  }

  let poll_stage_enabled = cfg.poll_stage_enabled;
  if (poll_stage_enabled && (!pollPipelineId || !pollStageId)) {
    poll_stage_enabled = false;
  }

  let post_call_webhook_enabled = cfg.post_call_webhook_enabled;
  if (post_call_webhook_enabled && !webhookUrl) {
    post_call_webhook_enabled = false;
  }

  return {
    ...cfg,
    due_at_time: cfg.due_at_time ? normalizeHHMM(cfg.due_at_time) : null,
    post_call_webhook_url: webhookUrl,
    post_call_webhook_enabled,
    poll_pipeline_id: pollPipelineId,
    poll_pipeline_stage_id: pollStageId,
    poll_stage_enabled,
    opportunity_custom_field_id: opportunityId,
    opportunity_custom_field_key: trimOrNull(cfg.opportunity_custom_field_key),
    opportunity_custom_field_label: trimOrNull(cfg.opportunity_custom_field_label),
    opportunity_custom_field_value: opportunityValue,
    opportunity_custom_field_value_label: trimOrNull(
      cfg.opportunity_custom_field_value_label
    ),
    opportunity_custom_field_enabled,
  };
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
