import type { AgentTaskConfig, CallOutcome } from "@/types";

/** Whether a post-call CRM task should be created for this outcome and duration. */
export function shouldCreateTask(
  cfg: AgentTaskConfig,
  outcome: string,
  durationSeconds: number
): boolean {
  if (cfg.min_duration_seconds > 0 && durationSeconds < cfg.min_duration_seconds) {
    return false;
  }
  if (!cfg.only_outcomes || cfg.only_outcomes.length === 0) return true;
  return cfg.only_outcomes.includes(outcome as CallOutcome);
}

/** assignee_crm_id may hold one id or comma/space-separated ids for multi-assignee tasks. */
export function parseAssignees(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
