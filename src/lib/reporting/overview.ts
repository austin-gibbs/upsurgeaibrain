// =====================================================================
// Cross-workspace home reporting: roll up Retell DB call rows into
// global aggregates + per-workspace / per-agent KPI slices.
// Pure — no I/O. Unit-testable.
// =====================================================================
import {
  aggregateReporting,
  type NormalizedCallRow,
  type ReportingAggregates,
  type ReportingKpis,
  type TimeSeriesPoint,
} from "@/lib/reporting/aggregate";
import type { AgentDirection } from "@/types";

/** Lean call row for home overview — no raw_payload (avoids multi-MB transfers). */
export type LeanOverviewCallRow = {
  id: string;
  retell_call_id: string | null;
  agent_id: string;
  workspace_id: string;
  outcome: string | null;
  in_voicemail: boolean | null;
  completed_at: string | null;
  dialed_at: string | null;
  queued_at: string;
  direction: string;
};

/**
 * Normalize a lean DB call row for overview aggregation without reading
 * raw_payload. Cost / latency / sentiment stay at defaults; duration is
 * estimated from dialed→completed when both timestamps exist.
 */
export function normalizeLeanOverviewCall(
  row: LeanOverviewCallRow,
  agentName: string | null
): NormalizedCallRow & { workspaceId: string } {
  const direction = (row.direction === "inbound" ? "inbound" : "outbound") as AgentDirection;
  const completedMs = row.completed_at ? Date.parse(row.completed_at) : NaN;
  const dialedMs = row.dialed_at ? Date.parse(row.dialed_at) : NaN;
  const queuedMs = Date.parse(row.queued_at);
  const startTimestamp = Number.isFinite(dialedMs)
    ? dialedMs
    : Number.isFinite(completedMs)
      ? completedMs
      : Number.isFinite(queuedMs)
        ? queuedMs
        : null;

  let durationSeconds = 0;
  if (Number.isFinite(completedMs) && Number.isFinite(dialedMs) && completedMs >= dialedMs) {
    durationSeconds = Math.round((completedMs - dialedMs) / 1000);
  }

  const outcome = row.outcome;
  const inVoicemail = row.in_voicemail === true;
  const outcomeLower = (outcome ?? "").toLowerCase();
  const noAnswer =
    inVoicemail ||
    outcomeLower.includes("no_answer") ||
    outcomeLower.includes("voicemail");

  return {
    retellCallId: row.retell_call_id ?? row.id,
    agentId: row.agent_id,
    agentName,
    direction,
    startTimestamp,
    completedAt: row.completed_at,
    durationSeconds,
    fromNumber: null,
    toNumber: null,
    phone: null,
    contactName: null,
    contactEmail: null,
    crmContactId: null,
    recordingUrl: null,
    summary: null,
    outcome,
    callSuccessful: !noAnswer && !!outcome && outcome !== "error",
    userSentiment: null,
    inVoicemail,
    disconnectionReason: null,
    cost: 0,
    latencyP50Ms: null,
    latencyP90Ms: null,
    workspaceId: row.workspace_id,
  };
}

export type OverviewRangeDays = 7 | 30 | 90;
export type OverviewInterval = "daily" | "weekly";

export type OverviewWorkspaceMeta = {
  id: string;
  name: string;
  timezone: string;
  crm_provider: string;
  is_active: boolean;
  enroll_tag?: string | null;
};

export type OverviewAgentMeta = {
  id: string;
  name: string;
  status: string;
  direction: string;
  retell_agent_id: string | null;
  workspace_id: string;
};

export type OverviewWorkspaceKpis = Pick<
  ReportingKpis,
  | "totalCalls"
  | "inboundCalls"
  | "outboundCalls"
  | "answerRate"
  | "successRate"
  | "appointmentCount"
  | "avgDurationSeconds"
  | "totalCost"
  | "sentimentPositive"
>;

export type OverviewAgentRow = {
  id: string;
  name: string;
  status: string;
  direction: string;
  retell_agent_id: string | null;
  calls: number;
};

export type OverviewWorkspaceRow = OverviewWorkspaceMeta & {
  agentCount: number;
  activeAgents: number;
  agents: OverviewAgentRow[];
  kpis: OverviewWorkspaceKpis;
};

export type OverviewTotals = {
  workspaceCount: number;
  activeWorkspaceCount: number;
  agentCount: number;
  activeAgentCount: number;
  totalCalls: number;
  answerRate: number;
  appointmentCount: number;
  totalCost: number;
};

export type OverviewResult = {
  totals: OverviewTotals;
  global: ReportingAggregates;
  workspaces: OverviewWorkspaceRow[];
  /** Timezone used for global date bucketing. */
  referenceTimezone: string;
};

const FALLBACK_TZ = "America/Denver";

function compactKpis(kpis: ReportingKpis): OverviewWorkspaceKpis {
  return {
    totalCalls: kpis.totalCalls,
    inboundCalls: kpis.inboundCalls,
    outboundCalls: kpis.outboundCalls,
    answerRate: kpis.answerRate,
    successRate: kpis.successRate,
    appointmentCount: kpis.appointmentCount,
    avgDurationSeconds: kpis.avgDurationSeconds,
    totalCost: kpis.totalCost,
    sentimentPositive: kpis.sentimentPositive,
  };
}

/**
 * Pick the most common workspace timezone for global date bucketing.
 * Mixed-tz orgs get a best-effort roll-up; per-workspace KPIs still use
 * each workspace's own timezone.
 */
export function pickReferenceTimezone(
  workspaces: OverviewWorkspaceMeta[]
): string {
  if (workspaces.length === 0) return FALLBACK_TZ;
  const counts = new Map<string, number>();
  for (const ws of workspaces) {
    const tz = ws.timezone?.trim() || FALLBACK_TZ;
    counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  let best = FALLBACK_TZ;
  let bestCount = 0;
  for (const [tz, count] of counts) {
    if (count > bestCount) {
      best = tz;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Re-bucket daily calls-over-time into ISO week buckets (Mon–Sun).
 * Expects daily points with `date` as YYYY-MM-DD.
 */
export function bucketCallsOverTimeWeekly(
  daily: TimeSeriesPoint[]
): TimeSeriesPoint[] {
  if (daily.length === 0) return [];

  const weeks = new Map<string, { inbound: number; outbound: number }>();

  for (const point of daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    const weekKey = isoWeekStart(point.date);
    const entry = weeks.get(weekKey) ?? { inbound: 0, outbound: 0 };
    entry.inbound += point.inbound;
    entry.outbound += point.outbound;
    weeks.set(weekKey, entry);
  }

  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      inbound: v.inbound,
      outbound: v.outbound,
      total: v.inbound + v.outbound,
    }));
}

/** Monday (UTC calendar) of the ISO week containing YYYY-MM-DD. */
function isoWeekStart(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  // getUTCDay: 0=Sun … 6=Sat → shift so Monday=0
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
}

/**
 * Apply interval re-bucketing to a full ReportingAggregates for the home charts.
 * Daily = passthrough; weekly collapses callsOverTime (and latencyOverTime).
 */
export function applyOverviewInterval(
  aggregates: ReportingAggregates,
  interval: OverviewInterval
): ReportingAggregates {
  if (interval === "daily") return aggregates;
  return {
    ...aggregates,
    callsOverTime: bucketCallsOverTimeWeekly(aggregates.callsOverTime),
    latencyOverTime: bucketLatencyWeekly(aggregates.latencyOverTime),
  };
}

function bucketLatencyWeekly(
  daily: ReportingAggregates["latencyOverTime"]
): ReportingAggregates["latencyOverTime"] {
  if (daily.length === 0) return [];
  const weeks = new Map<string, { p50: number[]; p90: number[] }>();
  for (const point of daily) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) continue;
    const weekKey = isoWeekStart(point.date);
    const entry = weeks.get(weekKey) ?? { p50: [], p90: [] };
    if (point.p50Ms > 0) entry.p50.push(point.p50Ms);
    if (point.p90Ms > 0) entry.p90.push(point.p90Ms);
    weeks.set(weekKey, entry);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({
      date,
      p50Ms: avg(v.p50),
      p90Ms: avg(v.p90),
    }));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, n) => s + n, 0) / values.length;
}

export function buildOverview(
  calls: Array<NormalizedCallRow & { workspaceId: string }>,
  workspaces: OverviewWorkspaceMeta[],
  agents: OverviewAgentMeta[],
  referenceTimezone?: string
): OverviewResult {
  const refTz = referenceTimezone ?? pickReferenceTimezone(workspaces);
  const globalCalls: NormalizedCallRow[] = calls.map(
    ({ workspaceId: _ws, ...rest }) => rest
  );
  const global = aggregateReporting(globalCalls, refTz);

  const agentsByWorkspace = new Map<string, OverviewAgentMeta[]>();
  for (const agent of agents) {
    const list = agentsByWorkspace.get(agent.workspace_id) ?? [];
    list.push(agent);
    agentsByWorkspace.set(agent.workspace_id, list);
  }

  const callsByWorkspace = new Map<string, NormalizedCallRow[]>();
  const callsByAgent = new Map<string, number>();
  for (const call of calls) {
    const list = callsByWorkspace.get(call.workspaceId) ?? [];
    list.push(call);
    callsByWorkspace.set(call.workspaceId, list);
    if (call.agentId) {
      callsByAgent.set(call.agentId, (callsByAgent.get(call.agentId) ?? 0) + 1);
    }
  }

  const workspaceRows: OverviewWorkspaceRow[] = workspaces.map((ws) => {
    const wsAgents = agentsByWorkspace.get(ws.id) ?? [];
    const wsCalls = callsByWorkspace.get(ws.id) ?? [];
    const agg = aggregateReporting(wsCalls, ws.timezone || refTz);
    return {
      ...ws,
      agentCount: wsAgents.length,
      activeAgents: wsAgents.filter((a) => a.status === "active").length,
      agents: wsAgents.map((a) => ({
        id: a.id,
        name: a.name,
        status: a.status,
        direction: a.direction,
        retell_agent_id: a.retell_agent_id,
        calls: callsByAgent.get(a.id) ?? 0,
      })),
      kpis: compactKpis(agg.kpis),
    };
  });

  // Leaderboard default: most calls first, then name.
  workspaceRows.sort((a, b) => {
    if (b.kpis.totalCalls !== a.kpis.totalCalls) {
      return b.kpis.totalCalls - a.kpis.totalCalls;
    }
    return a.name.localeCompare(b.name);
  });

  const totals: OverviewTotals = {
    workspaceCount: workspaces.length,
    activeWorkspaceCount: workspaces.filter((w) => w.is_active).length,
    agentCount: agents.length,
    activeAgentCount: agents.filter((a) => a.status === "active").length,
    totalCalls: global.kpis.totalCalls,
    answerRate: global.kpis.answerRate,
    appointmentCount: global.kpis.appointmentCount,
    totalCost: global.kpis.totalCost,
  };

  return {
    totals,
    global,
    workspaces: workspaceRows,
    referenceTimezone: refTz,
  };
}
