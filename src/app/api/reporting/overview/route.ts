// =====================================================================
// GET /api/reporting/overview — cross-workspace Retell reporting for home.
// Query: range (7|30|90), interval (daily|weekly)
// RLS on the user client scopes workspaces/calls to the caller's orgs.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  normalizeStoredCall,
  type AgentMeta,
  type StoredCallJoinRow,
} from "@/lib/reporting/normalize";
import {
  buildOverview,
  type OverviewAgentMeta,
  type OverviewInterval,
  type OverviewRangeDays,
  type OverviewWorkspaceMeta,
} from "@/lib/reporting/overview";

export const runtime = "nodejs";

const PAGE_SIZE = 1000;
const DEFAULT_RANGE: OverviewRangeDays = 30;
const DEFAULT_INTERVAL: OverviewInterval = "weekly";

type OverviewCallRow = StoredCallJoinRow & {
  workspace_id: string;
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

function parseRangeDays(raw: string | null): OverviewRangeDays {
  if (raw === "7" || raw === "90") return Number(raw) as OverviewRangeDays;
  return DEFAULT_RANGE;
}

function parseInterval(raw: string | null): OverviewInterval {
  if (raw === "daily") return "daily";
  return DEFAULT_INTERVAL;
}

async function loadOverviewCalls({
  db,
  workspaceIds,
  fromIso,
  toExclusiveIso,
}: {
  db: ReturnType<typeof createServerClient>;
  workspaceIds: string[];
  fromIso: string;
  toExclusiveIso: string;
}): Promise<OverviewCallRow[]> {
  if (workspaceIds.length === 0) return [];

  const rows: OverviewCallRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from("calls")
      .select(
        "id, retell_call_id, agent_id, workspace_id, contact_id, to_number, outcome, in_voicemail, " +
          "summary, raw_payload, completed_at, dialed_at, queued_at, direction, " +
          "crm_contact_id, contact_name, contact_email"
      )
      .in("workspace_id", workspaceIds)
      .eq("status", "completed")
      .gte("completed_at", fromIso)
      .lt("completed_at", toExclusiveIso)
      .order("completed_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<OverviewCallRow[]>();

    if (error) throw new Error(`calls query failed: ${error.message}`);
    if (data?.length) rows.push(...data);
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

export async function GET(req: NextRequest) {
  const db = createServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const rangeDays = parseRangeDays(url.searchParams.get("range"));
  const interval = parseInterval(url.searchParams.get("interval"));

  const { data: workspacesRaw, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, timezone, crm_provider, is_active")
    .order("created_at", { ascending: false })
    .returns<OverviewWorkspaceMeta[]>();

  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }

  const workspaces = workspacesRaw ?? [];
  const workspaceIds = workspaces.map((w) => w.id);

  const { data: agentsRaw, error: agentsErr } = workspaceIds.length
    ? await db
        .from("agents")
        .select("id, name, status, direction, retell_agent_id, workspace_id")
        .in("workspace_id", workspaceIds)
        .order("created_at", { ascending: true })
        .returns<OverviewAgentMeta[]>()
    : { data: [] as OverviewAgentMeta[], error: null };

  if (agentsErr) {
    return NextResponse.json({ error: agentsErr.message }, { status: 500 });
  }

  const agents = agentsRaw ?? [];

  // Date window in a reference tz (most common workspace tz).
  const tzCounts = new Map<string, number>();
  for (const ws of workspaces) {
    const tz = ws.timezone?.trim() || "America/Denver";
    tzCounts.set(tz, (tzCounts.get(tz) ?? 0) + 1);
  }
  let referenceTimezone = "America/Denver";
  let bestCount = 0;
  for (const [tz, count] of tzCounts) {
    if (count > bestCount) {
      referenceTimezone = tz;
      bestCount = count;
    }
  }

  const now = new Date();
  const toYmd = ymdInTz(now, referenceTimezone);
  const fromYmd = addDaysYmd(toYmd, -rangeDays);
  const fromIso = localMidnightUtc(fromYmd, referenceTimezone).toISOString();
  const toExclusiveIso = localMidnightUtc(
    addDaysYmd(toYmd, 1),
    referenceTimezone
  ).toISOString();

  let callRows: OverviewCallRow[] = [];
  try {
    callRows = await loadOverviewCalls({
      db,
      workspaceIds,
      fromIso,
      toExclusiveIso,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "calls query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const agentById = new Map<string, AgentMeta>(
    agents.map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        retell_agent_id: a.retell_agent_id,
        direction: a.direction as AgentMeta["direction"],
      },
    ])
  );

  const normalized = callRows.map((row) => ({
    ...normalizeStoredCall(row, agentById),
    workspaceId: row.workspace_id,
  }));

  const overview = buildOverview(
    normalized,
    workspaces,
    agents,
    referenceTimezone
  );

  // Always return daily-bucketed global series. The home page re-buckets
  // to weekly via applyOverviewInterval without another network round-trip.
  const missingRawPayload = callRows.filter((row) => !row.raw_payload).length;

  return NextResponse.json({
    range: {
      days: rangeDays,
      from: fromIso,
      to: toExclusiveIso,
      fromYmd,
      toYmd,
    },
    interval,
    totals: overview.totals,
    global: overview.global,
    workspaces: overview.workspaces,
    referenceTimezone: overview.referenceTimezone,
    meta: {
      dataSource: "database" as const,
      completedInRange: callRows.length,
      missingRawPayload,
      hint:
        callRows.length === 0 && workspaces.length > 0
          ? "No completed calls in this range across your workspaces."
          : missingRawPayload > 0
            ? `${missingRawPayload} completed call(s) lack raw_payload — KPIs may be incomplete.`
            : null,
    },
  });
}
