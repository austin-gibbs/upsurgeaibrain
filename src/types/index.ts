// =====================================================================
// Shared domain types. These mirror the DB schema (supabase/migrations).
// =====================================================================

export type CrmProvider = "followupboss" | "highlevel" | "custom";

export type MemberRole = "owner" | "admin" | "member";

export type AgentStatus = "draft" | "active" | "paused";

/** Whether the agent dials out on a cadence or answers the business line. */
export type AgentDirection = "inbound" | "outbound";

export type CallOutcome =
  | "no_answer_voicemail"
  | "appointment"
  | "not_interested"
  | "dnd"
  | "interested_no_appointment"
  | "follow_up"
  | "error";

export type CallStatus = "queued" | "dialing" | "completed" | "failed";

export type CallFinalizedBy = "webhook" | "reconcile";

export type CallQueueStatus = "pending" | "dialing" | "completed" | "failed" | "cancelled";

export interface CallQueueEntry {
  id: string;
  workspace_id: string;
  agent_id: string;
  contact_id: string;
  status: CallQueueStatus;
  queue_day: string;
  position: number;
  scheduled_for: string | null;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  call_id: string | null;
  bullmq_job_id: string | null;
  error_message: string | null;
  /** Cadence attempt number for this queued outreach cycle. */
  attempt_number: number;
  /** Snapshot of dialable phones for this attempt (FUB may include all numbers). */
  phone_numbers: string[];
  /** Index into phone_numbers for the next dial in this attempt. */
  next_phone_index: number;
}

/** Outcomes that remove a contact from the call flow entirely. */
export const TERMINAL_OUTCOMES: CallOutcome[] = [
  "appointment",
  "not_interested",
  "dnd",
];

export interface Workspace {
  id: string;
  organization_id: string;
  name: string;
  timezone: string;
  crm_provider: CrmProvider;
  crm_credentials_encrypted: string | null;
  /** CRM connection health. null/"connected" = ok; "needs_reauth" = reconnect. */
  crm_status: string | null;
  crm_status_detail: string | null;
  /** Base URL for CRM contact pages, e.g. https://nilpatel.followupboss.com */
  crm_account_url: string | null;
  enroll_tag: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutcomeTag {
  workspace_id: string;
  outcome: CallOutcome;
  tag: string;
  is_terminal: boolean;
}

export interface Agent {
  id: string;
  workspace_id: string;
  name: string;
  /** CRM tag that enrolls contacts into this agent's call flow. Falls back to workspace.enroll_tag when null. */
  enroll_tag: string | null;
  /** Inbound (answers the line) vs outbound (dials on a cadence). */
  direction: AgentDirection;
  retell_agent_id: string | null;
  retell_from_number: string | null;
  objective: string | null;
  /** Legacy per-agent CRM fallback. Workspace CRM is used whenever configured. */
  crm_provider: CrmProvider | null;
  crm_credentials_encrypted: string | null;
  /** CRM connection health. null/"connected" = ok; "needs_reauth" = reconnect. */
  crm_status: string | null;
  crm_status_detail: string | null;
  /** Encrypted Retell creds ({ apiKey, webhookSecret? }); set for inbound agents. */
  retell_credentials_encrypted: string | null;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

/** ISO weekday numbers allowed for outbound dialing (1=Mon … 7=Sun). */
export type CallWindowDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const DEFAULT_CALL_WINDOW_DAYS: CallWindowDay[] = [1, 2, 3, 4, 5, 6, 7];

export interface AgentCallConfig {
  agent_id: string;
  max_total_calls: number | null;
  max_calls_per_day: number;
  max_attempts_per_contact: number;
  call_window_start: string;
  call_window_end: string;
  /** ISO weekdays (1=Mon … 7=Sun) when dialing is permitted. */
  call_window_days: number[];
  daily_run_at: string;
  drip_seconds: number;
  cadence_day_gaps: number[];
}

export interface AgentTaskConfig {
  agent_id: string;
  enabled: boolean;
  name_template: string;
  task_type: string;
  assignee_crm_id: string | null;
  assignee_label: string | null;
  due_offset_minutes: number;
  /** Fixed task due time-of-day (HH:MM) in the workspace timezone. When set, it
   * overrides due_offset_minutes and pins the task to today at this time. */
  due_at_time: string | null;
  /** When > 0, create CRM tasks only when call duration is >= this many seconds. */
  min_duration_seconds: number;
  only_outcomes: CallOutcome[] | null;
  post_call_webhook_enabled: boolean;
  post_call_webhook_url: string | null;
  post_call_webhook_only_outcomes: CallOutcome[] | null;
  /** HighLevel only: move the contact's opportunity to the mapped stage after each call. */
  pipeline_automation_enabled: boolean;
  /** HighLevel only: move queued contacts' opportunities to poll stage during poll. */
  poll_stage_enabled: boolean;
  poll_pipeline_id: string | null;
  poll_pipeline_stage_id: string | null;
  poll_pipeline_name: string | null;
  poll_stage_name: string | null;
  /** HighLevel only: set an opportunity custom-field dropdown on create/update. */
  opportunity_custom_field_enabled: boolean;
  opportunity_custom_field_id: string | null;
  opportunity_custom_field_key: string | null;
  opportunity_custom_field_label: string | null;
  opportunity_custom_field_value: string | null;
  opportunity_custom_field_value_label: string | null;
}

/** One outcome (+ optional call attempt) -> HighLevel pipeline stage routing rule. */
export interface AgentPipelineStageMap {
  id?: string;
  agent_id: string;
  outcome: CallOutcome;
  /** When set, rule applies only to this attempt. NULL = any attempt (fallback). */
  call_attempt: number | null;
  pipeline_id: string;
  pipeline_stage_id: string;
  /** Display-label caches so the UI can render the selection without a refetch. */
  pipeline_name: string | null;
  stage_name: string | null;
}

export interface Contact {
  id: string;
  workspace_id: string;
  crm_contact_id: string;
  full_name: string | null;
  email: string | null;
  phones: string[];
  tags: string[];
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: CallOutcome | null;
  /**
   * Custom-integration only: per-lead dynamic-variable overrides injected into
   * the Retell prompt (e.g. homeowner_name, agent_name, property_address). Null
   * for Follow Up Boss / HighLevel contacts.
   */
  dynamic_var_overrides?: Record<string, string> | null;
}

export interface AgentContactState {
  id: string;
  agent_id: string;
  contact_id: string;
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: CallOutcome | null;
  created_at: string;
  updated_at: string;
}

export interface Call {
  id: string;
  workspace_id: string;
  agent_id: string;
  contact_id: string | null;
  direction: AgentDirection;
  attempt_number: number;
  /** Zero-based index into the attempt's phone list. */
  phone_index: number;
  /** Total phones scheduled for this cadence attempt. */
  phone_count: number;
  to_number: string;
  retell_call_id: string | null;
  crm_contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  in_voicemail: boolean | null;
  summary: string | null;
  transcript: string | null;
  applied_tag: string | null;
  task_created: boolean;
  error_message: string | null;
  finalized_by: CallFinalizedBy | null;
  note_logged: boolean | null;
  recording_logged: boolean | null;
  tags_synced: boolean | null;
  crm_error: string | null;
  queued_at: string;
  dialed_at: string | null;
  completed_at: string | null;
}

export interface AgentMemory {
  id: string;
  workspace_id: string;
  agent_id: string;
  contact_id: string;
  summary: string;
  facts: Record<string, unknown>;
  objective_state: Record<string, unknown>;
  call_count: number;
  last_call_id: string | null;
  updated_at: string;
}

export type PollTriggerSource = "worker" | "manual" | "failover" | "scheduler";

export interface PollRun {
  id: string;
  workspace_id: string;
  agent_id: string;
  ran_at: string;
  scanned: number;
  eligible: number;
  enqueued: number;
  cancelled: number;
  tags_stripped: number;
  trigger_source: PollTriggerSource;
  skipped_reason: string | null;
  test_mode: boolean;
}
