// =====================================================================
// GET /api/console/status?workspace=<name>
//
// Read-only view of a workspace and its agents — status, direction, Retell
// from-number, CRM status, and the EFFECTIVE enroll tag (the agent's own tag,
// else the workspace tag) to tell the admin which tag to put on a contact.
// Mirrors scripts/show-agent.ts. Session + admin gated.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  if (!workspaceName) {
    return NextResponse.json(
      { error: "missing ?workspace=<name>" },
      { status: 400 }
    );
  }

  const db = createServiceClient();

  const { data: workspaces, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, timezone, enroll_tag, crm_provider, created_at")
    .eq("name", workspaceName)
    .order("created_at", { ascending: false });
  if (wsErr) {
    return NextResponse.json({ error: wsErr.message }, { status: 500 });
  }
  if (!workspaces || workspaces.length === 0) {
    return NextResponse.json(
      { error: `No workspace named "${workspaceName}" found.` },
      { status: 404 }
    );
  }
  const ws = workspaces[0] as {
    id: string;
    name: string;
    timezone: string;
    enroll_tag: string | null;
    crm_provider: string | null;
  };

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select(
      "id, name, status, direction, enroll_tag, retell_from_number, " +
        "crm_provider, crm_status, crm_status_detail"
    )
    .eq("workspace_id", ws.id);
  if (agErr) {
    return NextResponse.json({ error: agErr.message }, { status: 500 });
  }

  const rows = (agents ?? []) as unknown as Array<{
    id: string;
    name: string;
    status: string;
    direction: string;
    enroll_tag: string | null;
    retell_from_number: string | null;
    crm_provider: string | null;
    crm_status: string | null;
    crm_status_detail: string | null;
  }>;

  const enriched = rows.map((a) => ({
    ...a,
    effective_enroll_tag: a.enroll_tag ?? ws.enroll_tag,
  }));

  return NextResponse.json({
    ok: true,
    workspace: {
      id: ws.id,
      name: ws.name,
      timezone: ws.timezone,
      enroll_tag: ws.enroll_tag,
      crm_provider: ws.crm_provider,
    },
    agents: enriched,
  });
}
