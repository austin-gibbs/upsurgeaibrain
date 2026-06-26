// =====================================================================
// Fulfillment report — App-DB-only aggregation for the twice-daily Slack
// update in #fulfillment.
//
// For every active workspace, lists each agent with a per-workspace
// outcome breakdown (the workspace's configured outcome taxonomy, so
// outcomes are effectively agent-dependent) plus total calls. Totals are
// cumulative for the current day in the report timezone (Mountain Time by
// default), i.e. since 12:00 AM MT.
//
// Pure + dependency-light: imports only the Supabase client type so it can
// be reused by both the API route (src/app/api/cron/fulfillment-report)
// and the standalone CLI script (scripts/fulfillment-report.ts).
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FulfillmentOutcome {
  outcome: string;
  count: number;
}

export interface FulfillmentAgent {
  id: string;
  name: string;
  status: string;
  outcomes: FulfillmentOutcome[];
  totalCalls: number;
}

export interface FulfillmentWorkspace {
  id: string;
  name: string;
  timezone: string;
  agents: FulfillmentAgent[];
}

export interface FulfillmentReport {
  generatedAt: string; // ISO, end of window (now)
  windowStart: string; // ISO, midnight in reportTimezone
  windowEnd: string; // ISO, == generatedAt
  reportTimezone: string;
  workspaces: FulfillmentWorkspace[];
}

// Display order: positive / high-value outcomes first, then neutral, then
// terminal-negative, then catch-alls. Anything unknown sorts last.
const OUTCOME_ORDER = [
  "appointment",
  "interested_no_appointment",
  "follow_up",
  "voicemail",
  "no_answer",
  "no_answer_voicemail",
  "not_interested",
  "dnd",
  "error",
];

function outcomeRank(outcome: string): number {
  const i = OUTCOME_ORDER.indexOf(outcome);
  return i === -1 ? OUTCOME_ORDER.length : i;
}

/**
 * The UTC instant corresponding to today's 00:00:00 wall-clock time in `tz`.
 * DST-correct: the offset is resolved at the target local midnight instant.
 */
export function dayStartUtc(now: Date = new Date(), tz = "America/Denver"): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(guess))
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});

  // Intl renders hour 24 for midnight in some runtimes; normalize to 0.
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  const offset = localAsUtc - guess; // ms the tz is ahead of UTC
  return new Date(guess - offset);
}

/**
 * Build the fulfillment report from the application database only.
 * Pass a SERVICE-ROLE Supabase client so cross-tenant reads bypass RLS.
 */
export async function buildFulfillmentReport(
  db: SupabaseClient,
  opts: { now?: Date; tz?: string } = {}
): Promise<FulfillmentReport> {
  const tz = opts.tz ?? "America/Denver";
  const now = opts.now ?? new Date();
  const start = dayStartUtc(now, tz);
  const windowStart = start.toISOString();
  const windowEnd = now.toISOString();

  const report: FulfillmentReport = {
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    reportTimezone: tz,
    workspaces: [],
  };

  const { data: workspaces, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, timezone")
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (wsErr) throw new Error(`workspaces query failed: ${wsErr.message}`);

  const wsList = (workspaces ?? []) as Array<{
    id: string;
    name: string;
    timezone: string;
  }>;
  const wsIds = wsList.map((w) => w.id);
  if (wsIds.length === 0) return report;

  const [{ data: agents, error: aErr }, { data: tags, error: tErr }, { data: calls, error: cErr }] =
    await Promise.all([
      db
        .from("agents")
        .select("id, workspace_id, name, status")
        .in("workspace_id", wsIds)
        .order("name", { ascending: true }),
      db
        .from("workspace_outcome_tags")
        .select("workspace_id, outcome")
        .in("workspace_id", wsIds),
      db
        .from("calls")
        .select("agent_id, outcome")
        .in("workspace_id", wsIds)
        .gte("completed_at", windowStart)
        .lte("completed_at", windowEnd),
    ]);
  if (aErr) throw new Error(`agents query failed: ${aErr.message}`);
  if (tErr) throw new Error(`outcome tags query failed: ${tErr.message}`);
  if (cErr) throw new Error(`calls query failed: ${cErr.message}`);

  const agentRows = (agents ?? []) as Array<{
    id: string;
    workspace_id: string;
    name: string;
    status: string;
  }>;
  const tagRows = (tags ?? []) as Array<{ workspace_id: string; outcome: string }>;
  const callRows = (calls ?? []) as Array<{ agent_id: string; outcome: string | null }>;

  const configuredByWs = new Map<string, Set<string>>();
  for (const t of tagRows) {
    const set = configuredByWs.get(t.workspace_id) ?? new Set<string>();
    set.add(t.outcome);
    configuredByWs.set(t.workspace_id, set);
  }

  const countsByAgent = new Map<string, Map<string, number>>();
  const totalByAgent = new Map<string, number>();
  for (const c of callRows) {
    const outcome = c.outcome ?? "error";
    const counts = countsByAgent.get(c.agent_id) ?? new Map<string, number>();
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    countsByAgent.set(c.agent_id, counts);
    totalByAgent.set(c.agent_id, (totalByAgent.get(c.agent_id) ?? 0) + 1);
  }

  const agentsByWs = new Map<string, typeof agentRows>();
  for (const a of agentRows) {
    const arr = agentsByWs.get(a.workspace_id) ?? [];
    arr.push(a);
    agentsByWs.set(a.workspace_id, arr);
  }

  for (const w of wsList) {
    const configured = configuredByWs.get(w.id) ?? new Set<string>();
    const wsAgents = agentsByWs.get(w.id) ?? [];
    const agentsOut: FulfillmentAgent[] = wsAgents.map((a) => {
      const counts = countsByAgent.get(a.id) ?? new Map<string, number>();
      // Union of the workspace's configured outcomes (so zeros show) and any
      // outcome actually observed (guards against legacy/unconfigured values).
      const outcomeKeys = new Set<string>([...configured, ...counts.keys()]);
      const outcomes: FulfillmentOutcome[] = [...outcomeKeys]
        .sort((x, y) => outcomeRank(x) - outcomeRank(y) || x.localeCompare(y))
        .map((outcome) => ({ outcome, count: counts.get(outcome) ?? 0 }));
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        outcomes,
        totalCalls: totalByAgent.get(a.id) ?? 0,
      };
    });
    report.workspaces.push({
      id: w.id,
      name: w.name,
      timezone: w.timezone,
      agents: agentsOut,
    });
  }

  return report;
}

function prettyTime(iso: string, tz: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return { date, time };
}

/**
 * Render the report as Slack-friendly Markdown (the format used by the
 * #fulfillment update).
 */
export function formatFulfillmentSlack(report: FulfillmentReport): string {
  const { date, time } = prettyTime(report.generatedAt, report.reportTimezone);
  const lines: string[] = [];
  lines.push(`**AI Agent Fulfillment Update — ${date}, ${time} MT**`);
  lines.push(`_Cumulative totals since 12:00 AM MT_`);
  lines.push("");

  if (report.workspaces.length === 0) {
    lines.push("_No active workspaces found._");
    return lines.join("\n");
  }

  for (const w of report.workspaces) {
    lines.push(`**Workspace: ${w.name}**`);
    if (w.agents.length === 0) {
      lines.push("- _No agents configured_");
      lines.push("");
      continue;
    }
    for (const a of w.agents) {
      lines.push(`- **${a.name}**`);
      for (const o of a.outcomes) {
        lines.push(`    - ${o.outcome}: ${o.count}`);
      }
      lines.push(`    - **Total Calls: ${a.totalCalls}**`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
