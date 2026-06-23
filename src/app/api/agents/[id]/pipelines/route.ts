// =====================================================================
// GET /api/agents/:id/pipelines — list the CRM pipelines + stages for this
// agent, used to populate the outcome -> stage mapping UI. HighLevel only;
// returns an empty list for CRMs without pipeline support (Follow Up Boss).
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import type { Agent, Workspace } from "@/types";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Authorize through RLS: the user must be able to see this agent.
  const { data: visible } = await userClient
    .from("agents")
    .select("id, workspace_id")
    .eq("id", params.id)
    .single<{ id: string; workspace_id: string }>();
  if (!visible) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Service client to read encrypted creds + build the adapter.
  const db = createServiceClient();
  const [{ data: agent }, { data: workspace }] = await Promise.all([
    db.from("agents").select("*").eq("id", params.id).single<Agent>(),
    db.from("workspaces").select("*").eq("id", visible.workspace_id).single<Workspace>(),
  ]);
  if (!agent || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let crm;
  try {
    crm = getCrmAdapterForAgent(agent, workspace);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "no CRM configured" }, { status: 400 });
  }

  // CRM has no pipeline concept (e.g. Follow Up Boss).
  if (!crm.listPipelines) return NextResponse.json({ pipelines: [] });

  try {
    const pipelines = await crm.listPipelines();
    return NextResponse.json({ pipelines });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "failed to load pipelines", pipelines: [] },
      { status: 502 }
    );
  }
}
