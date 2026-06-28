// =====================================================================
// GET /api/console/highlevel?workspace=<name>&agent=<name>
//
// Fetch the connected HighLevel account's pipelines (+ stages) and
// opportunity dropdown custom fields for an agent, so the admin/Claude can
// fill the IDs needed for outcome->stage routing, poll-stage routing, and the
// opportunity custom field. Mirrors GET /api/agents/[id]/pipelines and
// /opportunity-fields, but keyed by workspace + agent NAME and admin-gated.
//
// Returns { pipelines: [...], fields: [...] }. Empty arrays for CRMs without
// pipeline support (Follow Up Boss). Session + admin gated.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { resolveConsoleAgent } from "@/lib/console/resolve-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  const agentName = req.nextUrl.searchParams.get("agent")?.trim() || undefined;
  if (!workspaceName) {
    return NextResponse.json({ error: "missing ?workspace=<name>" }, { status: 400 });
  }

  const db = createServiceClient();
  const resolved = await resolveConsoleAgent(db, workspaceName, agentName);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { agent, workspace } = resolved;

  let crm;
  try {
    crm = getCrmAdapterForAgent(agent, workspace);
  } catch (e) {
    const m = e instanceof Error ? e.message : "no CRM configured";
    return NextResponse.json({ error: m }, { status: 400 });
  }

  const out: {
    ok: true;
    agent: string;
    pipelines: unknown[];
    fields: unknown[];
    warnings: string[];
  } = { ok: true, agent: agent.name, pipelines: [], fields: [], warnings: [] };

  if (crm.listPipelines) {
    try {
      out.pipelines = await crm.listPipelines();
    } catch (e) {
      out.warnings.push(
        `pipelines: ${e instanceof Error ? e.message : "failed to load"}`
      );
    }
  }
  if (crm.listOpportunityCustomFields) {
    try {
      out.fields = await crm.listOpportunityCustomFields();
    } catch (e) {
      out.warnings.push(
        `opportunity fields: ${e instanceof Error ? e.message : "failed to load"}`
      );
    }
  }

  return NextResponse.json(out);
}
