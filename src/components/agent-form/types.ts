export type CallConfig = {
  max_total_calls: number | null;
  max_calls_per_day: number;
  max_attempts_per_contact: number;
  call_window_start: string;
  call_window_end: string;
  call_window_days: number[];
  daily_run_at: string;
  drip_seconds: number;
  cadence_day_gaps: number[];
};

export const CALL_WINDOW_DAY_OPTIONS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

export type TaskConfig = {
  enabled: boolean;
  name_template: string;
  task_type: string;
  assignee_crm_id: string | null;
  assignee_label: string | null;
  due_offset_minutes: number;
  due_at_time: string | null;
  only_outcomes: string[] | null;
  post_call_webhook_enabled: boolean;
  post_call_webhook_url: string | null;
  post_call_webhook_only_outcomes: string[] | null;
  pipeline_automation_enabled: boolean;
  poll_stage_enabled: boolean;
  poll_pipeline_id: string | null;
  poll_pipeline_stage_id: string | null;
  poll_pipeline_name: string | null;
  poll_stage_name: string | null;
  opportunity_custom_field_enabled: boolean;
  opportunity_custom_field_id: string | null;
  opportunity_custom_field_key: string | null;
  opportunity_custom_field_label: string | null;
  opportunity_custom_field_value: string | null;
  opportunity_custom_field_value_label: string | null;
};

/** A CRM pipeline + its ordered stages, from GET /api/agents/:id/pipelines. */
export type Pipeline = {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
};

/** One opportunity custom dropdown field from GET /api/agents/:id/opportunity-fields. */
export type OpportunityCustomField = {
  id: string;
  key: string | null;
  name: string;
  dataType: string;
  options: { label: string; value: string }[];
};

/** One routing rule as edited in the form (outcome + optional attempt -> stage). */
export type StageMapEntry = {
  outcome: string;
  call_attempt: number | null;
  pipeline_id: string;
  pipeline_stage_id: string;
  pipeline_name: string | null;
  stage_name: string | null;
};

export const OUTCOMES = [
  "no_answer_voicemail",
  "appointment",
  "not_interested",
  "dnd",
  "interested_no_appointment",
  "follow_up",
] as const;

export function defaultCallConfig(): CallConfig {
  return {
    max_total_calls: null,
    max_calls_per_day: 100,
    max_attempts_per_contact: 10,
    call_window_start: "09:00",
    call_window_end: "18:00",
    call_window_days: [1, 2, 3, 4, 5, 6, 7],
    daily_run_at: "09:00",
    drip_seconds: 60,
    cadence_day_gaps: [0, 1, 2, 3, 5, 7, 10, 14, 21, 30],
  };
}

export function defaultTaskConfig(): TaskConfig {
  return {
    enabled: false,
    name_template: "UpSurge AI Call Review for {contact_name} on {date}",
    task_type: "Follow Up",
    assignee_crm_id: null,
    assignee_label: null,
    due_offset_minutes: 0,
    due_at_time: null,
    only_outcomes: null,
    post_call_webhook_enabled: false,
    post_call_webhook_url: null,
    post_call_webhook_only_outcomes: null,
    pipeline_automation_enabled: false,
    poll_stage_enabled: false,
    poll_pipeline_id: null,
    poll_pipeline_stage_id: null,
    poll_pipeline_name: null,
    poll_stage_name: null,
    opportunity_custom_field_enabled: false,
    opportunity_custom_field_id: null,
    opportunity_custom_field_key: null,
    opportunity_custom_field_label: null,
    opportunity_custom_field_value: null,
    opportunity_custom_field_value_label: null,
  };
}
