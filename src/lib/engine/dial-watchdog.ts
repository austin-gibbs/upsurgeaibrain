// Detect stalled dialing during open call windows (smoke alarm for ops).
import { createServiceClient } from "@/lib/supabase/server";
import { evaluateDialWindow, nowHHMMInTz } from "./cadence";
import { isHeartbeatStale, heartbeatAgeMs } from "./heartbeat";
import type { Agent, AgentCallConfig, Workspace } from "@/types";

type DbClient = ReturnType<typeof createServiceClient>;

export interface DialStallSignal {
  agentId: string;
  agentName: string;
  workspaceName: string;
  timezone: string;
  overduePending: number;
  recentDials: number;
  heartbeatStale: boolean;
  heartbeatAgeSec: number | null;
}

export interface DialWatchdogResult {
  checkedAgents: number;
  stalled: DialStallSignal[];
  heartbeatStale: boolean;
  heartbeatAgeSec: number | null;
}

export function shouldAlertDialStall(params: {
  windowOpen: boolean;
  overduePendingCount: number;
  recentDialCount: number;
  heartbeatStale: boolean;
}): boolean {
  if (!params.windowOpen) return false;
  if (params.heartbeatStale && params.overduePendingCount > 0) return true;
  if (params.overduePendingCount > 0 && params.recentDialCount === 0) return true;
  return false;
}

/**
 * Whether the Postgres-backed drain cron should take over dialing.
 * Triggers on stale heartbeat (worker dead) OR dial stall (zombie worker:
 * heartbeat fresh but overdue pending rows and no recent dials in-window).
 */
export function shouldTriggerFailoverDrain(params: {
  heartbeatStale: boolean;
  stalledAgentCount: number;
}): boolean {
  if (params.heartbeatStale) return true;
  return params.stalledAgentCount > 0;
}

export type FailoverDrainTrigger = "heartbeat_stale" | "dial_stall";

export function resolveFailoverDrainTrigger(params: {
  heartbeatStale: boolean;
  stalledAgentCount: number;
}): FailoverDrainTrigger | null {
  if (params.heartbeatStale) return "heartbeat_stale";
  if (params.stalledAgentCount > 0) return "dial_stall";
  return null;
}

/**
 * Scan active outbound agents for stalled dialing: open window + overdue pending
 * queue rows + no recent dials (or stale worker heartbeat).
 */
export async function checkDialStalls(opts?: {
  recentDialMinutes?: number;
  db?: DbClient;
}): Promise<DialWatchdogResult> {
  const recentDialMinutes = opts?.recentDialMinutes ?? 10;
  const supabase = opts?.db ?? createServiceClient();
  const nowIso = new Date().toISOString();
  const recentCutoff = new Date(Date.now() - recentDialMinutes * 60_000).toISOString();

  const heartbeatStale = await isHeartbeatStale(supabase);
  const ageMs = await heartbeatAgeMs(supabase);
  const heartbeatAgeSec = ageMs == null ? null : Math.round(ageMs / 1000);

  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, name, workspace_id, status, direction,
       agent_call_configs(call_window_start, call_window_end, daily_run_at),
       workspaces(name, timezone, is_active)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<
      (Pick<Agent, "id" | "name" | "workspace_id" | "status" | "direction"> & {
        agent_call_configs:
          | Pick<AgentCallConfig, "call_window_start" | "call_window_end" | "daily_run_at">
          | Pick<AgentCallConfig, "call_window_start" | "call_window_end" | "daily_run_at">[]
          | null;
        workspaces: Pick<Workspace, "name" | "timezone" | "is_active"> | null;
      })[]
    >();

  const stalled: DialStallSignal[] = [];

  for (const agent of agents ?? []) {
    const config = Array.isArray(agent.agent_call_configs)
      ? agent.agent_call_configs[0]
      : agent.agent_call_configs;
    const workspace = agent.workspaces;
    if (!config || !workspace?.is_active) continue;

    const windowOpen = evaluateDialWindow(
      workspace.timezone,
      config.call_window_start,
      config.call_window_end
    ).allowed;

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: workspace.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

    const { count: overduePending } = await supabase
      .from("call_queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .eq("queue_day", today)
      .eq("status", "pending")
      .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`);

    const { count: recentDials } = await supabase
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agent.id)
      .gte("dialed_at", recentCutoff);

    const overdue = overduePending ?? 0;
    const recent = recentDials ?? 0;

    if (
      shouldAlertDialStall({
        windowOpen,
        overduePendingCount: overdue,
        recentDialCount: recent,
        heartbeatStale,
      })
    ) {
      stalled.push({
        agentId: agent.id,
        agentName: agent.name,
        workspaceName: workspace.name,
        timezone: workspace.timezone,
        overduePending: overdue,
        recentDials: recent,
        heartbeatStale,
        heartbeatAgeSec,
      });
    }
  }

  return {
    checkedAgents: agents?.length ?? 0,
    stalled,
    heartbeatStale,
    heartbeatAgeSec,
  };
}

export function formatDialStallAlert(result: DialWatchdogResult): string {
  const lines = [
    ":rotating_light: *Dial engine stall detected*",
    `Worker heartbeat: ${result.heartbeatStale ? "STALE" : "ok"}${
      result.heartbeatAgeSec != null ? ` (${result.heartbeatAgeSec}s ago)` : ""
    }`,
    "",
  ];

  for (const s of result.stalled) {
    lines.push(
      `• *${s.workspaceName}* / ${s.agentName} (${s.timezone}, now ${nowHHMMInTz(s.timezone)})`,
      `  overdue pending: ${s.overduePending}, recent dials (${10}m): ${s.recentDials}`
    );
  }

  lines.push("", "Failover drain cron should take over until dials resume.");
  return lines.join("\n");
}
