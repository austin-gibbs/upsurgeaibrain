// =====================================================================
// GET /api/workspaces/:id/reporting — DB-backed Retell reporting data.
// Query: agentId (uuid | "all"), direction (all|inbound|outbound), from, to (YYYY-MM-DD)
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { aggregateReporting } from "@/lib/reporting/aggregate";
import {
  type AgentMeta,
  normalizeStoredCall,
  type StoredCallJoinRow,
} from "@/lib/reporting/normalize";
import { crmContactUrl } from "@/lib/crm/url";
import type { AgentDirection, Workspace } from "@/types";

export const runtime = "nodejs";

const DEFAULT_DAYS = 30;
const PAGE_SIZE = 1000;

type ReportingCallRow = StoredCallJoinRow & {
  contact_id: string | null;
};

function ymdInTz(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function localMidnightUtc(ymd: string, timezone: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
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

function ymdFromParam(
  param: string | null,
  fallback: string,
  timezone: string
): string {
  if (!param) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(param)) return param;
  const parsed = new Date(param);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return ymdInTz(parsed, timezone);
}

function parseDateRange(
  fromParam: string | null,
  toParam: string | null,
  timezone: string
): {
  fromIso: string;
  toIso: string;
  toExclusiveIso: string;
} {
  const now = new Date();
  const fallbackTo = ymdInTz(now, timezone);
  const fallbackFrom = addDaysYmd(fallbackTo, -DEFAULT_DAYS);
  const fromYmd = ymdFromParam(fromParam, fallbackFrom, timezone);
  const toYmd = ymdFromParam(toParam, fallbackTo, timezone);
  const from = localMidnightUtc(fromYmd, timezone);
  const toExclusive = localMidnightUtc(addDaysYmd(toYmd, 1), timezone);
  return {
    fromIso: from.toISOString(),
    toIso: toExclusive.toISOString(),
    toExclusiveIso: toExclusive.toISOString(),
  };
}

async function loadReportingCalls({
  db,
  workspaceId,
  agentIds,
  direction,
  fromIso,
  toExclusiveIso,
}: {
  db: ReturnType<typeof createServerClient>;
  workspaceId: string;
  agentIds: string[];
  direction: "all" | AgentDirection;
  fromIso: string;
  toExclusiveIso: string;
}): Promise<ReportingCallRow[]> {
  const rows: ReportingCallRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = db
      .from("calls")
      .select(
        "id, retell_call_id, agent_id, contact_id, to_number, outcome, in_voicemail, " +
          "summary, raw_payload, completed_at, dialed_at, queued_at, direction, " +
          "crm_contact_id, contact_name, contact_email"
      )
      .eq("workspace_id", workspaceId)
      .eq("status", "completed")
      .gte("completed_at", fromIso)
      .lt("completed_at", toExclusiveIso)
      .in("agent_id", agentIds);

    if (direction !== "all") query = query.eq("direction", direction);

    const { data, error } = await query
      .order("completed_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<ReportingCallRow[]>();
    if (error) throw new Error(`calls query failed: ${error.message}`);
    if (data?.length) rows.push(...data);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fillContactFallbacks(
  db: ReturnType<typeof createServerClient>,
  rows: ReportingCallRow[]
): Promise<ReportingCallRow[]> {
  const contactIds = [
    ...new Set(
      rows
        .filter((row) => row.contact_id && (!row.crm_contact_id || !row.contact_name || !row.contact_email))
        .map((row) => row.contact_id as string)
    ),
  ];
  if (contactIds.length === 0) return rows;

  const contacts = new Map<
    string,
    { id: string; crm_contact_id: string; full_name: string | null; email: string | null }
  >();
  for (let i = 0; i < contactIds.length; i += 500) {
    const { data } = await db
      .from("contacts")
      .select("id, crm_contact_id, full_name, email")
      .in("id", contactIds.slice(i, i + 500))
      .returns<
        { id: string; crm_contact_id: string; full_name: string | null; email: string | null }[]
      >();
    for (const contact of data ?? []) contacts.set(contact.id, contact);
  }

  return rows.map((row) => {
    if (!row.contact_id) return row;
    const contact = contacts.get(row.contact_id);
    if (!contact) return row;
    return {
      ...row,
      crm_contact_id: row.crm_contact_id ?? contact.crm_contact_id,
      contact_name: row.contact_name ?? contact.full_name,
      contact_email: row.contact_email ?? contact.email,
    };
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const agentIdParam = url.searchParams.get("agentId") ?? "all";
  const directionParam = (url.searchParams.get("direction") ?? "all") as
    | "all"
    | AgentDirection;

  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .select("*")
    .eq("id", params.id)
    .single<Workspace>();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { fromIso, toIso, toExclusiveIso } = parseDateRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
    workspace.timezone
  );

  const { data: agentsRaw } = await db
    .from("agents")
    .select("id, name, direction, retell_agent_id, status")
    .eq("workspace_id", params.id)
    .order("created_at", { ascending: true });

  const agents = (agentsRaw ?? []) as Array<AgentMeta & { status: string }>;

  let targetAgents = [...agents];
  if (agentIdParam !== "all") {
    targetAgents = targetAgents.filter((a) => a.id === agentIdParam);
  }
  if (directionParam !== "all") {
    targetAgents = targetAgents.filter((a) => a.direction === directionParam);
  }

  if (targetAgents.length === 0) {
    const empty = aggregateReporting([], workspace.timezone);
    return NextResponse.json({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        timezone: workspace.timezone,
        crm_provider: workspace.crm_provider,
        crm_account_url: workspace.crm_account_url,
      },
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        direction: a.direction,
        retell_agent_id: a.retell_agent_id,
        status: a.status,
      })),
      range: { from: fromIso, to: toIso },
      filters: { agentId: agentIdParam, direction: directionParam },
      ...empty,
      calls: [],
    });
  }

  const targetAgentIds = targetAgents.map((a) => a.id);
  const callRows = await fillContactFallbacks(
    db,
    await loadReportingCalls({
      db,
      workspaceId: params.id,
      agentIds: targetAgentIds,
      direction: directionParam,
      fromIso,
      toExclusiveIso,
    })
  );

  const agentById = new Map(agents.map((a) => [a.id, a]));
  const normalized = callRows
    .map((row) => normalizeStoredCall(row, agentById))
    .sort((a, b) => (b.startTimestamp ?? 0) - (a.startTimestamp ?? 0));

  const aggregates = aggregateReporting(normalized, workspace.timezone);

  const callsWithUrls = normalized.map((c) => ({
    ...c,
    crmUrl: crmContactUrl(
      workspace.crm_provider,
      workspace.crm_account_url,
      c.crmContactId
    ),
  }));

  return NextResponse.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      timezone: workspace.timezone,
      crm_provider: workspace.crm_provider,
      crm_account_url: workspace.crm_account_url,
    },
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      direction: a.direction,
      retell_agent_id: a.retell_agent_id,
      status: a.status,
    })),
    range: { from: fromIso, to: toIso },
    filters: { agentId: agentIdParam, direction: directionParam },
    ...aggregates,
    calls: callsWithUrls,
  });
}
