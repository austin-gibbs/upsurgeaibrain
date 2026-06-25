// =====================================================================
// GET /api/agents/:id/opportunity-fields — list HighLevel opportunity
// dropdown custom fields for the agent settings UI.
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

  const { data: visible } = await userClient
    .from("agents")
    .select("id, workspace_id")
    .eq("id", params.id)
    .single<{ id: string; workspace_id: string }>();
  if (!visible) return NextResponse.json({ error: "not found" }, { status: 404 });

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

  if (!crm.listOpportunityCustomFields) {
    return NextResponse.json({ fields: [] });
  }

  try {
    const fields = await crm.listOpportunityCustomFields();
    return NextResponse.json({ fields });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "failed to load opportunity fields", fields: [] },
      { status: 502 }
    );
  }
}
