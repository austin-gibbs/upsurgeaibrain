// =====================================================================
// POST /api/workspaces/:id/run — manually poll all active outbound agents
// in a workspace (CRM enroll-tag scan → eligible contacts → dial queue).
// Optional testMode bypasses per-agent call windows and the Eastern guard.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { pollWorkspace } from "@/lib/engine/poller";
import { runWorkspacePollSchema } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .select("id, is_active")
    .eq("id", params.id)
    .single<{ id: string; is_active: boolean }>();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!workspace.is_active) {
    return NextResponse.json({ error: "workspace inactive" }, { status: 400 });
  }

  const json = await req.json().catch(() => ({}));
  const parsed = runWorkspacePollSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { data: agents } = await db
    .from("agents")
    .select("id, name")
    .eq("workspace_id", params.id)
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<{ id: string; name: string }[]>();

  if (!agents?.length) {
    return NextResponse.json(
      { error: "no active outbound agents in this workspace" },
      { status: 400 }
    );
  }

  const agentNames = new Map(agents.map((a) => [a.id, a.name]));
  const results = await pollWorkspace(params.id, { testMode: parsed.data.testMode });

  const enriched = results.map((r) => ({
    ...r,
    agentName: agentNames.get(r.agentId) ?? r.agentId,
    skippedReason: r.skippedReason ?? null,
  }));

  const totals = enriched.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      eligible: acc.eligible + r.eligible,
      enqueued: acc.enqueued + r.enqueued,
    }),
    { scanned: 0, eligible: 0, enqueued: 0 }
  );

  return NextResponse.json({
    ok: true,
    testMode: parsed.data.testMode,
    results: enriched,
    totals,
  });
}
