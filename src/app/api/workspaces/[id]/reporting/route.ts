// =====================================================================
// GET /api/workspaces/:id/reporting — hybrid Retell + DB reporting data.
// Query: agentId (uuid | "all"), direction (all|inbound|outbound), from, to (ISO dates)
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { getRetellClientForAgent } from "@/lib/retell/client";
import { aggregateReporting } from "@/lib/reporting/aggregate";
import {
  buildAgentRetellMap,
  buildDbCallMap,
  groupAgentsByRetellKey,
  normalizeRetellCall,
  type AgentMeta,
  type DbCallJoinRow,
} from "@/lib/reporting/normalize";
import { crmContactUrl } from "@/lib/crm/url";
import type { Agent, AgentDirection, Workspace } from "@/types";

export const runtime = "nodejs";

const DEFAULT_DAYS = 30;

function parseDateRange(fromParam: string | null, toParam: string | null): {
  fromMs: number;
  toMs: number;
  fromIso: string;
  toIso: string;
} {
  const now = new Date();
  const to = toParam ? new Date(toParam) : now;
  const from = fromParam
    ? new Date(fromParam)
    : new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
  return {
    fromMs: from.getTime(),
    toMs: to.getTime(),
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
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
  const { fromMs, toMs, fromIso, toIso } = parseDateRange(
    url.searchParams.get("from"),
    url.searchParams.get("to")
  );

  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .select("*")
    .eq("id", params.id)
    .single<Workspace>();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: agentsRaw } = await db
    .from("agents")
    .select("id, name, direction, retell_agent_id, retell_credentials_encrypted, status")
    .eq("workspace_id", params.id)
    .order("created_at", { ascending: true });

  const agents = (agentsRaw ?? []) as Array<
    AgentMeta & { retell_credentials_encrypted: string | null; status: string }
  >;

  let targetAgents = agents.filter((a) => a.retell_agent_id);
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

  const retellAgentIds = targetAgents
    .map((a) => a.retell_agent_id)
    .filter((id): id is string => Boolean(id));

  const filterCriteria: {
    agent_id: string[];
    call_status: Array<"ended">;
    start_timestamp: { lower_threshold: number; upper_threshold: number };
    direction?: AgentDirection[];
  } = {
    agent_id: retellAgentIds,
    call_status: ["ended"],
    start_timestamp: {
      lower_threshold: fromMs,
      upper_threshold: toMs,
    },
  };
  if (directionParam !== "all") {
    filterCriteria.direction = [directionParam];
  }

  const groups = groupAgentsByRetellKey(
    targetAgents.map((a) => ({
      ...a,
      retell_credentials_encrypted: a.retell_credentials_encrypted,
    }))
  );

  const retellItems: import("@/lib/retell/client").RetellCallListItem[] = [];
  const retellErrors: string[] = [];

  for (const [, groupAgents] of groups) {
    const sample = groupAgents[0];
    try {
      const client = getRetellClientForAgent(sample as Agent);
      const items = await client.listCalls(
        { filter_criteria: filterCriteria, sort_order: "descending", limit: 1000 },
        10
      );
      retellItems.push(...items);
    } catch (e) {
      retellErrors.push(
        e instanceof Error ? e.message : "Retell list-calls failed"
      );
    }
  }

  const retellCallIds = retellItems.map((i) => i.call_id).filter(Boolean);
  let dbRows: DbCallJoinRow[] = [];

  type CallJoinQuery = DbCallJoinRow & { contact_id: string | null };

  if (retellCallIds.length > 0) {
    const { data: calls } = await db
      .from("calls")
      .select(
        "retell_call_id, agent_id, contact_id, crm_contact_id, contact_name, contact_email, to_number, outcome, completed_at, direction"
      )
      .eq("workspace_id", params.id)
      .in("retell_call_id", retellCallIds.slice(0, 500))
      .returns<CallJoinQuery[]>();

    dbRows = (calls ?? []).map(({ contact_id: _cid, ...row }) => row);

    const missingContactIds = (calls ?? [])
      .filter((c) => !c.crm_contact_id && c.contact_id)
      .map((c) => c.contact_id as string);

    if (missingContactIds.length > 0) {
      const { data: contacts } = await db
        .from("contacts")
        .select("id, crm_contact_id, full_name, email")
        .in("id", missingContactIds.slice(0, 500))
        .returns<
          { id: string; crm_contact_id: string; full_name: string | null; email: string | null }[]
        >();

      const contactMap = new Map((contacts ?? []).map((c) => [c.id, c]));
      dbRows = dbRows.map((row) => {
        const call = (calls ?? []).find((c) => c.retell_call_id === row.retell_call_id);
        if (row.crm_contact_id || !call?.contact_id) return row;
        const contact = contactMap.get(call.contact_id);
        if (!contact) return row;
        return {
          ...row,
          crm_contact_id: contact.crm_contact_id,
          contact_name: contact.full_name,
          contact_email: contact.email,
        };
      });
    }
  }

  const agentByRetellId = buildAgentRetellMap(agents);
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const dbByRetellId = buildDbCallMap(dbRows);

  const normalized = retellItems
    .map((item) => {
      const row = normalizeRetellCall(item, agentByRetellId, dbByRetellId);
      if (!row) return null;
      if (!row.agentName && row.agentId) {
        row.agentName = agentById.get(row.agentId)?.name ?? null;
      }
      return row;
    })
    .filter((row): row is NonNullable<typeof row> => row != null)
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
    retellErrors: retellErrors.length ? retellErrors : undefined,
    ...aggregates,
    calls: callsWithUrls,
  });
}
