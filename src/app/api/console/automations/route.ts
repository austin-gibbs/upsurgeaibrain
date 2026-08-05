// =====================================================================
// /api/console/automations
//
// GET  ?workspace=<name>[&agent=<name>]  -> list post-call automation triggers
//      for the workspace. If an agent name is given, only that agent's triggers
//      plus workspace-wide (agent_id NULL) triggers are returned.
// POST { workspace, agent?, ...trigger }  -> create a new trigger. agent omitted
//      = applies to every agent in the workspace (agent_id NULL).
//
// New automations are DB rows — never code deploys. Admin (cross-org) gated.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { resolveConsoleWorkspace, resolveConsoleAgent } from "@/lib/console/resolve-agent";
import { automationTriggerCreateSchema } from "@/lib/engine/automations/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  const agentName = req.nextUrl.searchParams.get("agent")?.trim() || undefined;
  if (!workspaceName) {
    return NextResponse.json({ error: "missing ?workspace=<name>" }, { status: 400 });
  }

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  // Optional agent scope: match the named agent OR workspace-wide triggers.
  let agentId: string | null = null;
  if (agentName) {
    const resolved = await resolveConsoleAgent(db, workspaceName, agentName);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    agentId = resolved.agent.id;
  }

  let query = db
    .from("automation_triggers")
    .select("*")
    .eq("workspace_id", ws.workspace.id)
    .order("created_at", { ascending: false });
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const triggers = (data ?? []).filter(
    (t) => !agentId || t.agent_id === null || t.agent_id === agentId
  );
  return NextResponse.json({ ok: true, workspace: ws.workspace.name, triggers });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const workspaceName = String(json.workspace ?? "").trim();
  const agentName =
    typeof json.agent === "string" && json.agent.trim() ? json.agent.trim() : undefined;
  if (!workspaceName) {
    return NextResponse.json({ error: "missing { workspace: <name> }" }, { status: 400 });
  }

  const parsed = automationTriggerCreateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid trigger", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const db = createServiceClient();
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return NextResponse.json({ error: ws.error }, { status: ws.status });

  // agent omitted -> workspace-wide (agent_id NULL). Named -> scope to it.
  let agentId: string | null = null;
  if (agentName) {
    const resolved = await resolveConsoleAgent(db, workspaceName, agentName);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    agentId = resolved.agent.id;
  }

  const t = parsed.data;
  const { data, error } = await db
    .from("automation_triggers")
    .insert({
      workspace_id: ws.workspace.id,
      agent_id: agentId,
      name: t.name,
      description: t.description ?? null,
      enabled: t.enabled,
      match_type: t.match_type,
      conditions: t.conditions as unknown as never,
      action_type: t.action_type,
      action_config: t.action_config as unknown as never,
      dedupe_window_hours: t.dedupe_window_hours,
      max_attempts: t.max_attempts,
      only_outcomes: t.only_outcomes ?? null,
      created_by: guard.userId ?? null,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, trigger: data });
}
