export type CallConfig = {
  max_total_calls: number | null;
  max_calls_per_day: number;
  max_attempts_per_contact: number;
  call_window_start: string;
  call_window_end: string;
  daily_run_at: string;
  drip_seconds: number;
  cadence_day_gaps: number[];
};

export type TaskConfig = {
  enabled: boolean;
  name_template: string;
  task_type: string;
  assignee_crm_id: string | null;
  assignee_label: string | null;
  due_offset_minutes: number;
  only_outcomes: string[] | null;
  post_call_webhook_enabled: boolean;
  post_call_webhook_url: string | null;
  post_call_webhook_only_outcomes: string[] | null;
  pipeline_automation_enabled: boolean;
};

/** A CRM pipeline + its ordered stages, from GET /api/agents/:id/pipelines. */
export type Pipeline = {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
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
  "voicemail",
  "no_answer",
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
    only_outcomes: null,
    post_call_webhook_enabled: false,
    post_call_webhook_url: null,
    post_call_webhook_only_outcomes: null,
    pipeline_automation_enabled: false,
  };
}
