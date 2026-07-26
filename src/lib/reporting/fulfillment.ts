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
  totalCalls: number; // today, across the workspace's agents
  monthlySpend: number; // month-to-date Retell spend (USD)
  mtdMinutes: number; // month-to-date Retell talk minutes
}

export interface FulfillmentReport {
  generatedAt: string; // ISO, end of window (now)
  windowStart: string; // ISO, midnight in reportTimezone
  windowEnd: string; // ISO, == generatedAt
  monthStart: string; // ISO, 1st of month in reportTimezone
  reportTimezone: string;
  workspaces: FulfillmentWorkspace[]; // only workspaces with calls today
  totalCalls: number; // today, across all shown workspaces
  totalMonthlySpend: number; // month-to-date Retell spend across ALL active workspaces (USD)
  totalMtdMinutes: number; // month-to-date Retell talk minutes across ALL active workspaces
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
 * The UTC instant for the 1st of the current month at 00:00 wall-clock in `tz`.
 * DST-correct via the same offset-resolution trick as dayStartUtc.
 */
export function monthStartUtc(now: Date = new Date(), tz = "America/Denver"): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, 1, 0, 0, 0);

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

  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  const offset = localAsUtc - guess;
  return new Date(guess - offset);
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
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
  const monthStart = monthStartUtc(now, tz);
  const windowStart = start.toISOString();
  const windowEnd = now.toISOString();
  const monthStartIso = monthStart.toISOString();

  const report: FulfillmentReport = {
    generatedAt: windowEnd,
    windowStart,
    windowEnd,
    monthStart: monthStartIso,
    reportTimezone: tz,
    workspaces: [],
    totalCalls: 0,
    totalMonthlySpend: 0,
    totalMtdMinutes: 0,
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

  const [
    { data: agents, error: aErr },
    { data: tags, error: tErr },
    { data: calls, error: cErr },
    { data: monthCalls, error: mErr },
  ] = await Promise.all([
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
    // Month-to-date calls — for per-workspace Retell minutes + spend.
    //
    // raw_payload is the Retell webhook body. Live webhook AND the reconciler
    // store the enveloped shape { event, call: {...} }, but the app's own
    // parser (normalizeStoredCall) defensively falls back to the bare-call
    // shape, so we pull both nesting levels and coalesce in TS.
    //
    // Duration: use call.duration_ms (what the app uses everywhere) as the
    // primary source, falling back to call_cost.total_duration_seconds. Reading
    // only the billed seconds under-counts — Retell leaves it empty on some
    // accounts even when combined_cost is present (e.g. Diamond, LaSalle).
    // Spend: combined_cost (cents) lives only under call_cost.
    db
      .from("calls")
      .select(
        [
          "workspace_id",
          "cost_env:raw_payload->call->call_cost->>combined_cost",
          "cost_bare:raw_payload->call_cost->>combined_cost",
          "durms_env:raw_payload->call->>duration_ms",
          "durms_bare:raw_payload->>duration_ms",
          "billed_env:raw_payload->call->call_cost->>total_duration_seconds",
          "billed_bare:raw_payload->call_cost->>total_duration_seconds",
        ].join(", ")
      )
      .in("workspace_id", wsIds)
      .gte("completed_at", monthStartIso)
      .lte("completed_at", windowEnd),
  ]);
  if (aErr) throw new Error(`agents query failed: ${aErr.message}`);
  if (tErr) throw new Error(`outcome tags query failed: ${tErr.message}`);
  if (cErr) throw new Error(`calls query failed: ${cErr.message}`);
  if (mErr) throw new Error(`month calls query failed: ${mErr.message}`);

  const agentRows = (agents ?? []) as Array<{
    id: string;
    workspace_id: string;
    name: string;
    status: string;
  }>;
  const tagRows = (tags ?? []) as Array<{ workspace_id: string; outcome: string }>;
  const callRows = (calls ?? []) as Array<{ agent_id: string; outcome: string | null }>;
  const monthRows = (monthCalls ?? []) as unknown as Array<{
    workspace_id: string;
    cost_env: string | number | null;
    cost_bare: string | number | null;
    durms_env: string | number | null;
    durms_bare: string | number | null;
    billed_env: string | number | null;
    billed_bare: string | number | null;
  }>;

  // First non-null of the enveloped vs bare payload shape.
  const pick = (env: unknown, bare: unknown): number => {
    const e = toNumber(env);
    if (e !== 0) return e;
    return toNumber(bare);
  };

  const monthSpendByWs = new Map<string, number>();
  const monthSecondsByWs = new Map<string, number>();
  for (const c of monthRows) {
    // Retell reports combined_cost in CENTS — convert to USD.
    const cost = pick(c.cost_env, c.cost_bare) / 100;
    // Prefer wall-clock duration_ms; fall back to billed total_duration_seconds.
    const durMs = pick(c.durms_env, c.durms_bare);
    const secs = durMs > 0 ? durMs / 1000 : pick(c.billed_env, c.billed_bare);
    monthSpendByWs.set(c.workspace_id, (monthSpendByWs.get(c.workspace_id) ?? 0) + cost);
    monthSecondsByWs.set(c.workspace_id, (monthSecondsByWs.get(c.workspace_id) ?? 0) + secs);
    report.totalMonthlySpend += cost;
    report.totalMtdMinutes += secs / 60;
  }

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
    const agentsOut: FulfillmentAgent[] = wsAgents
      // Only agents that actually dialed today — drop the all-zero noise.
      .filter((a) => (totalByAgent.get(a.id) ?? 0) > 0)
      .map((a) => {
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

    const wsTotalCalls = agentsOut.reduce((sum, a) => sum + a.totalCalls, 0);
    // Only surface workspaces that made calls today.
    if (wsTotalCalls === 0) continue;

    report.workspaces.push({
      id: w.id,
      name: w.name,
      timezone: w.timezone,
      agents: agentsOut,
      totalCalls: wsTotalCalls,
      monthlySpend: monthSpendByWs.get(w.id) ?? 0,
      mtdMinutes: (monthSecondsByWs.get(w.id) ?? 0) / 60,
    });
    report.totalCalls += wsTotalCalls;
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
function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function mins(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} min`;
}

export function formatFulfillmentSlack(report: FulfillmentReport): string {
  const { date, time } = prettyTime(report.generatedAt, report.reportTimezone);
  const lines: string[] = [];
  lines.push(`**AI Agent Fulfillment Update — ${date}, ${time} MT**`);
  lines.push(
    `_Call outcomes = today (since 12:00 AM MT) · Minutes & spend = month-to-date Retell_`
  );
  lines.push("");

  if (report.workspaces.length === 0) {
    lines.push("_No workspaces made calls today._");
    lines.push("");
    lines.push(
      `**MTD totals — ${mins(report.totalMtdMinutes)} · ${usd(report.totalMonthlySpend)} Retell spend**`
    );
    return lines.join("\n").trim();
  }

  for (const w of report.workspaces) {
    lines.push(`**${w.name}**`);
    lines.push(
      `_${w.totalCalls} calls today · ${mins(w.mtdMinutes)} MTD · ${usd(w.monthlySpend)} MTD_`
    );
    for (const a of w.agents) {
      lines.push(`- **${a.name}** — ${a.totalCalls} calls`);
      for (const o of a.outcomes) {
        if (o.count === 0) continue; // only show outcomes that occurred
        lines.push(`    - ${o.outcome}: ${o.count}`);
      }
    }
    lines.push("");
  }

  lines.push(
    `**Totals — ${report.totalCalls} calls today · ${mins(
      report.totalMtdMinutes
    )} MTD · ${usd(report.totalMonthlySpend)} Retell spend MTD (all workspaces)**`
  );

  return lines.join("\n").trim();
}
