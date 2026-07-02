// Poll coverage helpers — detect agents missing recent poll_runs during open windows.
import { createServiceClient } from "@/lib/supabase/server";
import { POLL_INTERVAL_MINUTES } from "./poll-schedule";

type DbClient = ReturnType<typeof createServiceClient>;

/** Max age without a poll_runs row before coverage is considered missing. */
export const POLL_COVERAGE_MAX_AGE_MS =
  (POLL_INTERVAL_MINUTES * 2 + 1) * 60 * 1000;

export function pollCoverageCutoffIso(
  nowMs: number = Date.now(),
  maxAgeMs: number = POLL_COVERAGE_MAX_AGE_MS
): string {
  return new Date(nowMs - maxAgeMs).toISOString();
}

/**
 * True when an agent has no poll_runs row within the coverage window.
 * Used by poll-fallback and poll-watchdog during open call windows.
 */
export async function agentLacksRecentPollCoverage(
  agentId: string,
  opts?: { db?: DbClient; maxAgeMs?: number; nowMs?: number }
): Promise<boolean> {
  const supabase = opts?.db ?? createServiceClient();
  const cutoff = pollCoverageCutoffIso(opts?.nowMs, opts?.maxAgeMs);

  const { count, error } = await supabase
    .from("poll_runs")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .gte("ran_at", cutoff);

  if (error) throw new Error(error.message);
  return (count ?? 0) === 0;
}

/** Whether poll-fallback should run pollAgent for an in-window agent. */
export function shouldPollAgentInFailover(params: {
  infrastructureFailover: boolean;
  pollTickEligible: boolean;
  lacksPollCoverage: boolean;
}): boolean {
  if (!params.pollTickEligible) return false;
  if (params.infrastructureFailover) return true;
  return params.lacksPollCoverage;
}
