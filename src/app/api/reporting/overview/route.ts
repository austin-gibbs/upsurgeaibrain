// =====================================================================
// GET /api/reporting/overview — cross-workspace Retell reporting for home.
// Query: range (7|30|90), interval (daily|weekly)
//
// Performance: loads lean call columns only (no raw_payload). Shipping
// payloads for ~3k calls was ~20MB and dominated homepage TTFB.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  buildOverview,
  normalizeLeanOverviewCall,
  pickReferenceTimezone,
  type LeanOverviewCallRow,
  type OverviewAgentMeta,
  type OverviewInterval,
  type OverviewRangeDays,
  type OverviewWorkspaceMeta,
} from "@/lib/reporting/overview";

export const runtime = "nodejs";

const PAGE_SIZE = 1000;
const DEFAULT_RANGE: OverviewRangeDays = 30;
const DEFAULT_INTERVAL: OverviewInterval = "weekly";

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

async function loadLeanOverviewCalls({
  db,
  workspaceIds,
  fromIso,
  toExclusiveIso,
}: {
  db: ReturnType<typeof createServerClient>;
  workspaceIds: string[];
  fromIso: string;
  toExclusiveIso: string;
}): Promise<LeanOverviewCallRow[]> {
  if (workspaceIds.length === 0) return [];

  const rows: LeanOverviewCallRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await db
      .from("calls")
      .select(
        "id, retell_call_id, agent_id, workspace_id, outcome, in_voicemail, " +
          "completed_at, dialed_at, queued_at, direction"
      )
      .in("workspace_id", workspaceIds)
      .eq("status", "completed")
      .gte("completed_at", fromIso)
      .lt("completed_at", toExclusiveIso)
      .order("completed_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)
      .returns<LeanOverviewCallRow[]>();

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

  // Parallel metadata fetch — workspaces + agents are tiny vs call pages.
  const [wsResult, agentsResult] = await Promise.all([
    db
      .from("workspaces")
      .select("id, name, timezone, crm_provider, is_active, enroll_tag")
      .order("created_at", { ascending: false })
      .returns<OverviewWorkspaceMeta[]>(),
    db
      .from("agents")
      .select("id, name, status, direction, retell_agent_id, workspace_id")
      .order("created_at", { ascending: true })
      .returns<OverviewAgentMeta[]>(),
  ]);

  if (wsResult.error) {
    return NextResponse.json({ error: wsResult.error.message }, { status: 500 });
  }
  if (agentsResult.error) {
    return NextResponse.json({ error: agentsResult.error.message }, { status: 500 });
  }

  const workspaces = wsResult.data ?? [];
  const workspaceIds = new Set(workspaces.map((w) => w.id));
  // Agents query is org-wide via RLS; keep only agents in listed workspaces.
  const agents = (agentsResult.data ?? []).filter((a) =>
    workspaceIds.has(a.workspace_id)
  );
  const workspaceIdList = [...workspaceIds];

  const referenceTimezone = pickReferenceTimezone(workspaces);
  const now = new Date();
  const toYmd = ymdInTz(now, referenceTimezone);
  const fromYmd = addDaysYmd(toYmd, -rangeDays);
  const fromIso = localMidnightUtc(fromYmd, referenceTimezone).toISOString();
  const toExclusiveIso = localMidnightUtc(
    addDaysYmd(toYmd, 1),
    referenceTimezone
  ).toISOString();

  let callRows: LeanOverviewCallRow[] = [];
  try {
    callRows = await loadLeanOverviewCalls({
      db,
      workspaceIds: workspaceIdList,
      fromIso,
      toExclusiveIso,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "calls query failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const normalized = callRows.map((row) =>
    normalizeLeanOverviewCall(row, agentNameById.get(row.agent_id) ?? null)
  );

  const overview = buildOverview(
    normalized,
    workspaces,
    agents,
    referenceTimezone
  );

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
      missingRawPayload: 0,
      lean: true as const,
      hint:
        callRows.length === 0 && workspaces.length > 0
          ? "No completed calls in this range across your workspaces."
          : null,
    },
  });
}
