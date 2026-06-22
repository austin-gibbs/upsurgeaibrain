// =====================================================================
// Shared domain types. These mirror the DB schema (supabase/migrations).
// =====================================================================

export type CrmProvider = "followupboss" | "highlevel";

export type MemberRole = "owner" | "admin" | "member";

export type AgentStatus = "draft" | "active" | "paused";

export type CallOutcome =
  | "voicemail"
  | "no_answer"
  | "appointment"
  | "not_interested"
  | "dnd"
  | "interested_no_appointment"
  | "follow_up"
  | "error";

export type CallStatus = "queued" | "dialing" | "completed" | "failed";

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
  retell_agent_id: string | null;
  retell_from_number: string | null;
  objective: string | null;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentCallConfig {
  agent_id: string;
  max_total_calls: number | null;
  max_calls_per_day: number;
  max_attempts_per_contact: number;
  call_window_start: string;
  call_window_end: string;
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
  only_outcomes: CallOutcome[] | null;
}

export interface Contact {
  id: string;
  workspace_id: string;
  crm_contact_id: string;
  full_name: string | null;
  phones: string[];
  tags: string[];
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: CallOutcome | null;
}

export interface Call {
  id: string;
  workspace_id: string;
  agent_id: string;
  contact_id: string;
  attempt_number: number;
  to_number: string;
  retell_call_id: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  in_voicemail: boolean | null;
  summary: string | null;
  transcript: string | null;
  applied_tag: string | null;
  task_created: boolean;
  error_message: string | null;
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
