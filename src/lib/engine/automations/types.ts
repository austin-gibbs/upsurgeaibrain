// =====================================================================
// Post-call automation engine — shared types.
//
// A "trigger" is a config-driven rule (a row in automation_triggers). When a
// call is analyzed, the engine evaluates every enabled trigger for the call's
// workspace/agent against the Retell custom_analysis_data (plus a few
// call-context pseudo-fields). Each match becomes an automation_runs row that
// the executor worker drives to sent | failed | dead.
// =====================================================================
import type { CallOutcome } from "@/types";

/** Operators a condition can use against a field value. */
export type ConditionOperator =
  | "is_true"
  | "is_false"
  | "eq"
  | "neq"
  | "contains"
  | "exists"
  | "not_exists"
  | "in";

export interface AutomationCondition {
  /** Field name in custom_analysis_data, or a pseudo-field (outcome/summary/transcript). */
  field: string;
  operator: ConditionOperator;
  /** Comparison value. For `in`, an array (or comma-separated string). */
  value?: unknown;
}

export type MatchType = "all" | "any";
export type AutomationActionType = "webhook" | "highlevel_sms" | "internal_notify";
/** Which call direction a trigger matches. Default 'all' preserves pre-0035 behaviour. */
export type AutomationDirectionScope = "all" | "inbound" | "outbound";
export type CallDirection = "inbound" | "outbound";

export interface AutomationActionConfig {
  url?: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  /** Message body template. Supports {{...}} placeholders (see render.ts). */
  message_template?: string;
  /** Which analysis field names the link_type to resolve from automation_links. */
  link_type_field?: string;
  /** Or pin a single link_type regardless of what the call said. */
  static_link_type?: string;
  /** Optional custom JSON body; when absent a default payload is sent. */
  payload_template?: Record<string, unknown>;
}

export interface AutomationTrigger {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  match_type: MatchType;
  conditions: AutomationCondition[];
  action_type: AutomationActionType;
  action_config: AutomationActionConfig;
  dedupe_window_hours: number;
  max_attempts: number;
  only_outcomes: string[] | null;
  /** Which call direction this trigger matches. Defaults to 'all'. */
  direction_scope: AutomationDirectionScope;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationLink {
  id: string;
  workspace_id: string;
  link_type: string;
  url: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export type AutomationRunStatus = "queued" | "sent" | "failed" | "dead" | "skipped";

export interface AutomationRun {
  id: string;
  workspace_id: string;
  trigger_id: string | null;
  agent_id: string | null;
  call_id: string | null;
  retell_call_id: string | null;
  contact_id: string | null;
  contact_phone: string | null;
  status: AutomationRunStatus;
  attempts: number;
  max_attempts: number;
  action_type: string | null;
  request_url: string | null;
  request_payload: Record<string, unknown> | null;
  response_status: number | null;
  response_body: string | null;
  last_error: string | null;
  meta: Record<string, unknown>;
  scheduled_at: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The call-context snapshot the evaluator matches conditions against. */
export interface AutomationEvalContext {
  outcome: CallOutcome | string;
  /** Call direction — used by direction_scope gating. Defaults treated as outbound. */
  direction?: CallDirection;
  summary: string | null;
  transcript: string | null;
  /** Retell call.recording_url for this call, when available. */
  recordingUrl: string | null;
  /** Full Retell custom_analysis_data (agent-defined post-call fields). */
  customFields: Record<string, unknown>;
  contact: {
    first_name: string | null;
    full_name: string | null;
    email: string | null;
    phone: string;
  };
}
