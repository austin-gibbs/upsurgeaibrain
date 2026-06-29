// =====================================================================
// Client-services report — App-DB-only aggregation for the twice-daily
// Slack update in #client-services.
//
// Mixes two windows on purpose:
//   • Calls + spend  — TODAY (since 12:00 AM in the report timezone).
//   • Minutes + bill — MONTH-TO-DATE (since the 1st), because the client
//     plan is monthly: up to INCLUDED_MINUTES of talk per month, then
//     OVERAGE_RATE per minute over the cap.
//
// For every active workspace it lists each agent with its day call count
// and dollars spent (Retell cost), a per-workspace day total, the
// month-to-date talk minutes vs the cap (with % used), and the overage
// bill. Plus a grand total across all workspaces.
//
// Money sources (the app stores no billing/pricing of its own):
//   • spend  = Retell platform cost  (raw_payload.call_cost.combined_cost)
//   • minutes= Retell talk duration  (raw_payload.call_cost.total_duration_seconds)
//   • bill   = max(0, mtdMinutes - INCLUDED_MINUTES) * OVERAGE_RATE
//
// Reuses dayStartUtc from ./fulfillment for DST-correct day windows.
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { dayStartUtc } from "./fulfillment";

// Plan terms (uniform across clients today). If plans diverge per client,
// move these onto the workspace row and read them per workspace.
export const INCLUDED_MINUTES = 1200;
export const OVERAGE_RATE = 0.12; // USD per minute over the cap

export interface ClientServicesAgent {
  id: string;
  name: string;
  status: string;
  totalCalls: number; // today
  spend: number; // today, USD (Retell combined_cost)
}

export interface ClientServicesWorkspace {
  id: string;
  name: string;
  timezone: string;
  agents: ClientServicesAgent[];
  totalCalls: number; // today
  spend: number; // today, USD
  mtdMinutes: number; // month-to-date talk minutes
  includedMinutes: number;
  minutesPct: number; // mtdMinutes / includedMinutes, as a fraction
  overageMinutes: number; // max(0, mtdMinutes - includedMinutes)
  overageBill: number; // overageMinutes * OVERAGE_RATE, USD
}

export interface ClientServicesReport {
  generatedAt: string; // ISO, end of window (now)
  dayStart: string; // ISO, midnight today in reportTimezone
  monthStart: string; // ISO, 1st of month in reportTimezone
  reportTimezone: string;
  includedMinutes: number;
  overageRate: number;
  workspaces: ClientServicesWorkspace[];
  totalCalls: number; // today
  totalSpend: number; // today, USD
  totalOverageBill: number; // month-to-date, USD
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * UTC instant for the 1st of the current month at 00:00 wall-clock in `tz`.
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

/**
 * Build the client-services report from the application database only.
 * Pass a SERVICE-ROLE Supabase client so cross-tenant reads bypass RLS.
 */
export async function buildClientServicesReport(
  db: SupabaseClient,
  opts: { now?: Date; tz?: string } = {}
): Promise<ClientServicesReport> {
  const tz = opts.tz ?? "America/Denver";
  const now = opts.now ?? new Date();
  const dayStart = dayStartUtc(now, tz);
  const monthStart = monthStartUtc(now, tz);
  const nowIso = now.toISOString();

  const report: ClientServicesReport = {
    generatedAt: nowIso,
    dayStart: dayStart.toISOString(),
    monthStart: monthStart.toISOString(),
    reportTimezone: tz,
    includedMinutes: INCLUDED_MINUTES,
    overageRate: OVERAGE_RATE,
    workspaces: [],
    totalCalls: 0,
    totalSpend: 0,
    totalOverageBill: 0,
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
    { data: dayCalls, error: dErr },
    { data: monthCalls, error: mErr },
  ] = await Promise.all([
    db
      .from("agents")
      .select("id, workspace_id, name, status")
      .in("workspace_id", wsIds)
      .order("name", { ascending: true }),
    // Today's calls — for per-agent call counts and spend.
    db
      .from("calls")
      .select("agent_id, combined_cost:raw_payload->call_cost->>combined_cost")
      .in("workspace_id", wsIds)
      .gte("completed_at", report.dayStart)
      .lte("completed_at", nowIso),
    // Month-to-date calls — for talk minutes / overage per workspace.
    db
      .from("calls")
      .select(
        "workspace_id, duration_seconds:raw_payload->call_cost->>total_duration_seconds"
      )
      .in("workspace_id", wsIds)
      .gte("completed_at", report.monthStart)
      .lte("completed_at", nowIso),
  ]);
  if (aErr) throw new Error(`agents query failed: ${aErr.message}`);
  if (dErr) throw new Error(`day calls query failed: ${dErr.message}`);
  if (mErr) throw new Error(`month calls query failed: ${mErr.message}`);

  const agentRows = (agents ?? []) as Array<{
    id: string;
    workspace_id: string;
    name: string;
    status: string;
  }>;
  const dayRows = (dayCalls ?? []) as Array<{
    agent_id: string;
    combined_cost: string | number | null;
  }>;
  const monthRows = (monthCalls ?? []) as Array<{
    workspace_id: string;
    duration_seconds: string | number | null;
  }>;

  const callsByAgent = new Map<string, number>();
  const spendByAgent = new Map<string, number>();
  for (const c of dayRows) {
    callsByAgent.set(c.agent_id, (callsByAgent.get(c.agent_id) ?? 0) + 1);
    spendByAgent.set(c.agent_id, (spendByAgent.get(c.agent_id) ?? 0) + toNumber(c.combined_cost));
  }

  const mtdSecondsByWs = new Map<string, number>();
  for (const c of monthRows) {
    mtdSecondsByWs.set(
      c.workspace_id,
      (mtdSecondsByWs.get(c.workspace_id) ?? 0) + toNumber(c.duration_seconds)
    );
  }

  const agentsByWs = new Map<string, typeof agentRows>();
  for (const a of agentRows) {
    const arr = agentsByWs.get(a.workspace_id) ?? [];
    arr.push(a);
    agentsByWs.set(a.workspace_id, arr);
  }

  for (const w of wsList) {
    const wsAgents = agentsByWs.get(w.id) ?? [];
    let wsCalls = 0;
    let wsSpend = 0;
    const agentsOut: ClientServicesAgent[] = wsAgents.map((a) => {
      const totalCalls = callsByAgent.get(a.id) ?? 0;
      const spend = spendByAgent.get(a.id) ?? 0;
      wsCalls += totalCalls;
      wsSpend += spend;
      return { id: a.id, name: a.name, status: a.status, totalCalls, spend };
    });

    const mtdMinutes = (mtdSecondsByWs.get(w.id) ?? 0) / 60;
    const overageMinutes = Math.max(0, mtdMinutes - INCLUDED_MINUTES);
    const overageBill = overageMinutes * OVERAGE_RATE;

    report.workspaces.push({
      id: w.id,
      name: w.name,
      timezone: w.timezone,
      agents: agentsOut,
      totalCalls: wsCalls,
      spend: wsSpend,
      mtdMinutes,
      includedMinutes: INCLUDED_MINUTES,
      minutesPct: INCLUDED_MINUTES > 0 ? mtdMinutes / INCLUDED_MINUTES : 0,
      overageMinutes,
      overageBill,
    });
    report.totalCalls += wsCalls;
    report.totalSpend += wsSpend;
    report.totalOverageBill += overageBill;
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

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function minutes(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Render the client-services report as Slack-friendly Markdown.
 */
export function formatClientServicesSlack(report: ClientServicesReport): string {
  const { date, time } = prettyTime(report.generatedAt, report.reportTimezone);
  const lines: string[] = [];
  lines.push(`**AI Agent — Client Services Update — ${date}, ${time} MT**`);
  lines.push(
    `_Calls & spend = today (since 12:00 AM MT) · Minutes & bill = month-to-date · ` +
      `Plan: ${minutes(report.includedMinutes)} min/mo, ${usd(report.overageRate)}/min overage_`
  );
  lines.push("");

  if (report.workspaces.length === 0) {
    lines.push("_No active workspaces found._");
    return lines.join("\n");
  }

  for (const w of report.workspaces) {
    lines.push(`**Workspace: ${w.name}**`);
    if (w.agents.length === 0) {
      lines.push("- _No agents configured_");
    } else {
      for (const a of w.agents) {
        lines.push(`- **${a.name}** — Calls: ${a.totalCalls} · Spend: ${usd(a.spend)}`);
      }
    }
    lines.push(`- **Workspace total — Calls: ${w.totalCalls} · Spend: ${usd(w.spend)}**`);
    const overageStr =
      w.overageMinutes > 0
        ? `Overage: ${minutes(w.overageMinutes)} min × ${usd(report.overageRate)} = **${usd(
            w.overageBill
          )}**`
        : `Overage: **none**`;
    lines.push(
      `- Minutes (MTD): ${minutes(w.mtdMinutes)} / ${minutes(w.includedMinutes)} ` +
        `(${pct(w.minutesPct)}) · ${overageStr}`
    );
    lines.push("");
  }

  lines.push(
    `**Grand total — Calls: ${report.totalCalls} · Spend: ${usd(
      report.totalSpend
    )} · Overage billed: ${usd(report.totalOverageBill)}**`
  );

  return lines.join("\n").trim();
}
