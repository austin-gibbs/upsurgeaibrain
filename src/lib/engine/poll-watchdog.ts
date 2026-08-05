// Detect outbound agents in an open call window with no poll activity, and
// contacts enrolled under a tag no agent polls.
import { createServiceClient } from "@/lib/supabase/server";
import { effectiveEnrollTag } from "@/lib/agents/enroll-tag";
import { evaluateDialWindow, nowHHMMInTz } from "./cadence";
import { isAgentEligibleForPollTick } from "./poll-schedule";
import { agentLacksRecentPollCoverage, POLL_COVERAGE_MAX_AGE_MS } from "./poll-coverage";
import { findOrphanEnrollTags, type OrphanEnrollTag } from "./orphan-enroll-tags";
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

export interface OrphanEnrollTagSignal {
  workspaceId: string;
  workspaceName: string;
  orphans: OrphanEnrollTag[];
}

const CONTACT_TAG_PAGE = 1000;

/** Every contact's tags for one workspace, paginated past PostgREST's default. */
async function loadContactTagSets(
  supabase: DbClient,
  workspaceId: string
): Promise<string[][]> {
  const out: string[][] = [];
  for (let offset = 0; ; offset += CONTACT_TAG_PAGE) {
    const { data, error } = await supabase
      .from("contacts")
      .select("tags")
      .eq("workspace_id", workspaceId)
      .range(offset, offset + CONTACT_TAG_PAGE - 1)
      .returns<{ tags: string[] | null }[]>();
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    for (const row of data) out.push(row.tags ?? []);
    if (data.length < CONTACT_TAG_PAGE) break;
  }
  return out;
}

/**
 * Find contacts tagged for enrollment under a tag no active outbound agent
 * polls. The poller cannot detect this itself — it only ever sees what its own
 * tag returns — so these contacts silently never reach the call queue.
 */
export async function checkOrphanEnrollTags(opts?: {
  db?: DbClient;
}): Promise<OrphanEnrollTagSignal[]> {
  const supabase = opts?.db ?? createServiceClient();

  const { data: workspaces } = await supabase
    .from("workspaces")
    .select("id, name, enroll_tag")
    .eq("is_active", true)
    .returns<Pick<Workspace, "id" | "name" | "enroll_tag">[]>();
  if (!workspaces?.length) return [];

  const { data: agents } = await supabase
    .from("agents")
    .select("workspace_id, enroll_tag")
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<Pick<Agent, "workspace_id" | "enroll_tag">[]>();

  const { data: outcomeTags } = await supabase
    .from("workspace_outcome_tags")
    .select("workspace_id, tag")
    .returns<{ workspace_id: string; tag: string }[]>();

  const signals: OrphanEnrollTagSignal[] = [];

  for (const workspace of workspaces) {
    const agentEnrollTags = (agents ?? [])
      .filter((a) => a.workspace_id === workspace.id)
      .map((a) => effectiveEnrollTag(a.enroll_tag, workspace.enroll_tag));
    if (agentEnrollTags.length === 0) continue;

    const contactTagSets = await loadContactTagSets(supabase, workspace.id);
    const orphans = findOrphanEnrollTags({
      contactTagSets,
      agentEnrollTags,
      outcomeTags: (outcomeTags ?? [])
        .filter((t) => t.workspace_id === workspace.id)
        .map((t) => t.tag),
    });

    // Only a near-miss is actionable enough to page on. Legacy or
    // client-owned tags still show in the Ops tab.
    if (orphans.some((o) => o.isNearMiss)) {
      signals.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        orphans: orphans.filter((o) => o.isNearMiss),
      });
    }
  }

  return signals;
}

export function formatOrphanEnrollTagAlert(signals: OrphanEnrollTagSignal[]): string {
  const lines = [
    ":warning: *Contacts enrolled under a tag no agent polls*",
    "These contacts are never scanned, so they never reach the call queue.",
    "",
  ];

  for (const signal of signals) {
    lines.push(`• *${signal.workspaceName}*`);
    for (const orphan of signal.orphans) {
      lines.push(
        `  \`${orphan.tag}\` — ${orphan.contactCount} contact${
          orphan.contactCount === 1 ? "" : "s"
        }, likely meant \`${orphan.nearestEnrollTag}\``
      );
    }
  }

  lines.push("", "Retag the contacts in the CRM, or point the agent at the tag in use.");
  return lines.join("\n");
}

export function formatPollGapAlert(result: PollWatchdogResult): string {
  const coverageSec = Math.round(POLL_COVERAGE_MAX_AGE_MS / 1000);
  const lines = [
    ":rotating_light: *Poll coverage gap detected*",
    `No poll_runs in the last ~${coverageSec} seconds during open call windows.`,
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
