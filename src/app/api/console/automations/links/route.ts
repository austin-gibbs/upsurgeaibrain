// =====================================================================
// /api/console/automations/links
//
// GET    ?workspace=<name>                    -> the workspace link map.
// POST   { workspace, link_type, url, label } -> upsert one link (by link_type).
// DELETE ?workspace=<name>&link_type=<t>      -> remove one link.
//
// The link map is what lets the HighLevel workflow stay "dumb": the APP owns
// which URL is sent for each link_type, so the same workflow works for every
// client and swapping a URL is a data edit, not a workflow change.
//
// Admin (cross-org) gated.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { resolveConsoleWorkspace } from "@/lib/console/resolve-agent";
import { automationLinkUpsertSchema } from "@/lib/engine/automations/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  if (!workspaceName) {
    return NextResponse.json({ error: "missing ?workspace=<name>" }, { status: 400 });
  }

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  const { data, error } = await db
    .from("automation_links")
    .select("*")
    .eq("workspace_id", ws.workspace.id)
    .order("link_type", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, workspace: ws.workspace.name, links: data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const workspaceName = String(json.workspace ?? "").trim();
  if (!workspaceName) {
    return NextResponse.json({ error: "missing { workspace: <name> }" }, { status: 400 });
  }

  const parsed = automationLinkUpsertSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid link", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  const { data, error } = await db
    .from("automation_links")
    .upsert(
      {
        workspace_id: ws.workspace.id,
        link_type: parsed.data.link_type,
        url: parsed.data.url,
        label: parsed.data.label ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,link_type" }
    )
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, link: data });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  const linkType = req.nextUrl.searchParams.get("link_type")?.trim();
  if (!workspaceName || !linkType) {
    return NextResponse.json(
      { error: "missing ?workspace=<name>&link_type=<type>" },
      { status: 400 }
    );
  }

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  const { error } = await db
    .from("automation_links")
    .delete()
    .eq("workspace_id", ws.workspace.id)
    .eq("link_type", linkType);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: linkType });
}
