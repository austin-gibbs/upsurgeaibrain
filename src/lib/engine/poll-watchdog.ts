// Detect outbound agents in an open call window with no poll activity.
import { createServiceClient } from "@/lib/supabase/server";
import { evaluateDialWindow, nowHHMMInTz } from "./cadence";
import { isAgentEligibleForPollTick } from "./poll-schedule";
import { agentLacksRecentPollCoverage, POLL_COVERAGE_MAX_AGE_MS } from "./poll-coverage";
import type { Agent, AgentCallConfig, Workspace } from "@/types";

type DbClient = ReturnType<typeof createServiceClient>;

export interface PollGapSignal {
  agentId: string;
  agentName: string;
  workspaceName: string;
  timezone: string;
  callWindowStart: string;
  callWindowEnd: string;
  activeQueueRows: number;
  recentDials: number;
  locallyTaggedEstimate: number;
}

export interface PollWatchdogResult {
  checkedAgents: number;
  gaps: PollGapSignal[];
}

export function shouldAlertPollGap(params: {
  pollTickEligible: boolean;
  lacksPollCoverage: boolean;
  activeQueueCount: number;
  recentDialCount: number;
}): boolean {
  if (!params.pollTickEligible) return false;
  if (!params.lacksPollCoverage) return false;
  if (params.activeQueueCount > 0) return false;
  if (params.recentDialCount > 0) return false;
  return true;
}

type AgentRow = Pick<Agent, "id" | "name" | "workspace_id" | "enroll_tag"> & {
  agent_call_configs:
    | Pick<
        AgentCallConfig,
        "daily_run_at" | "call_window_start" | "call_window_end" | "call_window_days"
      >
    | Pick<
        AgentCallConfig,
        "daily_run_at" | "call_window_start" | "call_window_end" | "call_window_days"
      >[]
    | null;
  workspaces: Pick<Workspace, "name" | "timezone" | "is_active" | "enroll_tag"> | null;
};

function pickConfig(agent: AgentRow) {
  return Array.isArray(agent.agent_call_configs)
    ? agent.agent_call_configs[0]
    : agent.agent_call_configs;
}

/**
 * Scan active outbound agents for missing poll coverage during open windows.
 */
export async function checkPollGaps(opts?: {
  recentDialMinutes?: number;
  db?: DbClient;
}): Promise<PollWatchdogResult> {
  const recentDialMinutes = opts?.recentDialMinutes ?? 10;
  const supabase = opts?.db ?? createServiceClient();
  const recentCutoff = new Date(Date.now() - recentDialMinutes * 60_000).toISOString();

  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, name, workspace_id, enroll_tag,
       agent_call_configs(daily_run_at, call_window_start, call_window_end, call_window_days),
       workspaces(name, timezone, is_active, enroll_tag)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<AgentRow[]>();

  const gaps: PollGapSignal[] = [];

  for (const agent of agents ?? []) {
    const config = pickConfig(agent);
    const workspace = agent.workspaces;
    if (!config?.daily_run_at || !workspace?.is_active) continue;

    const pollTickEligible = isAgentEligibleForPollTick({
      timezone: workspace.timezone,
      dailyRunAt: config.daily_run_at,
      callWindowStart: config.call_window_start,
      callWindowEnd: config.call_window_end,
      callWindowDays: config.call_window_days,
    });

    const windowOpen = evaluateDialWindow(
      workspace.timezone,
      config.call_window_start,
      config.call_window_end,
      config.call_window_days
    ).allowed;

    if (!pollTickEligible && !windowOpen) continue;

    const [lacksCoverage, queueRes, dialRes, taggedRes] = await Promise.all([
      agentLacksRecentPollCoverage(agent.id, { db: supabase }),
      supabase
        .from("call_queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agent.id)
        .in("status", ["pending", "dialing"]),
      supabase
        .from("calls")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agent.id)
        .gte("dialed_at", recentCutoff),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", agent.workspace_id)
        .contains("tags", [agent.enroll_tag ?? workspace.enroll_tag]),
    ]);

    const activeQueueCount = queueRes.count ?? 0;
    const recentDialCount = dialRes.count ?? 0;

    if (
      shouldAlertPollGap({
        pollTickEligible,
        lacksPollCoverage: lacksCoverage,
        activeQueueCount,
        recentDialCount,
      })
    ) {
      gaps.push({
        agentId: agent.id,
        agentName: agent.name,
        workspaceName: workspace.name,
        timezone: workspace.timezone,
        callWindowStart: config.call_window_start,
        callWindowEnd: config.call_window_end,
        activeQueueRows: activeQueueCount,
        recentDials: recentDialCount,
        locallyTaggedEstimate: taggedRes.count ?? 0,
      });
    }
  }

  return { checkedAgents: agents?.length ?? 0, gaps };
}

export function formatPollGapAlert(result: PollWatchdogResult): string {
  const coverageMin = Math.round(POLL_COVERAGE_MAX_AGE_MS / 60_000);
  const lines = [
    ":rotating_light: *Poll coverage gap detected*",
    `No poll_runs in the last ~${coverageMin} minutes during open call windows.`,
    "",
  ];

  for (const gap of result.gaps) {
    lines.push(
      `• *${gap.workspaceName}* / ${gap.agentName}`,
      `  tz ${gap.timezone}, now ${nowHHMMInTz(gap.timezone)}, window ${gap.callWindowStart}-${gap.callWindowEnd}`,
      `  locally tagged: ${gap.locallyTaggedEstimate}, queue: ${gap.activeQueueRows}, recent dials: ${gap.recentDials}`
    );
  }

  lines.push("", "poll-fallback should backfill polls; verify scheduler + poll worker liveness.");
  return lines.join("\n");
}
