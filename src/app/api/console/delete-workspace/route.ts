// =====================================================================
// POST /api/console/delete-workspace
//
// Hard-delete a workspace by name. Pauses agents, drains pending BullMQ jobs,
// then deletes the workspace row (child data cascades). Session + admin gated.
//
// Body: { workspace: <name>, confirmName: <name>, dryRun?: boolean }
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import {
  deleteWorkspaceById,
  findWorkspaceByName,
} from "@/lib/workspaces/delete-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const json = await req.json().catch(() => null);
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const workspaceName = String(
    (json as { workspace?: unknown }).workspace ?? ""
  ).trim();
  const confirmName = String(
    (json as { confirmName?: unknown }).confirmName ?? ""
  ).trim();
  const dryRun = Boolean((json as { dryRun?: unknown }).dryRun);

  if (!workspaceName) {
    return NextResponse.json(
      { error: "missing { workspace: <name> }" },
      { status: 400 }
    );
  }

  if (!dryRun) {
    if (!confirmName) {
      return NextResponse.json(
        { error: "missing { confirmName: <name> } — type the workspace name to confirm" },
        { status: 400 }
      );
    }
    if (confirmName !== workspaceName) {
      return NextResponse.json(
        { error: "confirmName does not match workspace name" },
        { status: 400 }
      );
    }
  }

  const db = createServiceClient();

  let ws;
  try {
    ws = await findWorkspaceByName(db, workspaceName);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!ws) {
    return NextResponse.json(
      { error: `No workspace named "${workspaceName}" found.` },
      { status: 404 }
    );
  }

  try {
    const result = await deleteWorkspaceById(db, ws.id, { dryRun });
    if (!result) {
      return NextResponse.json({ error: "workspace not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
