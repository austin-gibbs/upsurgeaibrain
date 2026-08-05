// =====================================================================
// /api/console/automations/runs
//
// GET ?workspace=<name>[&status=<s>][&triggerId=<id>][&limit=N]
//     -> the automation run log for a workspace (newest first). This is the
//        audit trail: every match becomes a run row (queued/sent/failed/
//        dead/skipped) with the resolved request + last delivery result.
//
// Admin (cross-org) gated. Read-only.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { resolveConsoleWorkspace } from "@/lib/console/resolve-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_STATUS = new Set(["queued", "sent", "failed", "dead", "skipped"]);

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  if (!workspaceName) {
    return NextResponse.json({ error: "missing ?workspace=<name>" }, { status: 400 });
  }
  const status = req.nextUrl.searchParams.get("status")?.trim();
  const triggerId = req.nextUrl.searchParams.get("triggerId")?.trim();
  const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  let query = db
    .from("automation_runs")
    .select("*")
    .eq("workspace_id", ws.workspace.id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status && VALID_STATUS.has(status)) query = query.eq("status", status);
  if (triggerId) query = query.eq("trigger_id", triggerId);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, workspace: ws.workspace.name, runs: data ?? [] });
}
