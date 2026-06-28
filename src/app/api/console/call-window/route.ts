// =====================================================================
// POST /api/console/call-window
//
// Rewrite the call window / cadence on the agent_call_configs for every agent
// in a workspace. Mirrors scripts/update-call-window.ts. Defaults encode
// "call once a day at 11pm local for 30 days". The window is enforced in the
// workspace's own timezone. Session + admin gated.
//
// Body: { workspace: <name>, start?, end?, runAt?, gap?, attempts? }.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const json = (await req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const workspaceName = String(json.workspace ?? "").trim();
  if (!workspaceName) {
    return NextResponse.json(
      { error: "missing { workspace: <name> }" },
      { status: 400 }
    );
  }

  const start = String(json.start ?? "23:00");
  const end = String(json.end ?? "23:59");
  const runAt = String(json.runAt ?? "23:00");
  const gap = Number(json.gap ?? 1);
  const attempts = Number(json.attempts ?? 30);
  if (!Number.isFinite(gap) || !Number.isFinite(attempts)) {
    return NextResponse.json(
      { error: "gap and attempts must be numbers" },
      { status: 400 }
    );
  }

  const db = createServiceClient();

  const { data: workspaces, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, timezone, created_at")
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
  const ws = workspaces[0] as { id: string; name: string; timezone: string };

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select("id, name")
    .eq("workspace_id", ws.id);
  if (agErr) {
    return NextResponse.json({ error: agErr.message }, { status: 500 });
  }
  if (!agents || agents.length === 0) {
    return NextResponse.json(
      { error: `No agents in workspace "${ws.name}".` },
      { status: 404 }
    );
  }

  const patch = {
    call_window_start: start,
    call_window_end: end,
    daily_run_at: runAt,
    cadence_day_gaps: [gap],
    max_attempts_per_contact: attempts,
    updated_at: new Date().toISOString(),
  };

  const updated: string[] = [];
  for (const agent of agents as Array<{ id: string; name: string }>) {
    const { error } = await db
      .from("agent_call_configs")
      .upsert({ agent_id: agent.id, ...patch }, { onConflict: "agent_id" });
    if (error) {
      return NextResponse.json(
        {
          error: `failed to update config for agent ${agent.id}: ${error.message}`,
        },
        { status: 500 }
      );
    }
    updated.push(agent.name);
  }

  return NextResponse.json({
    ok: true,
    workspace: ws.name,
    timezone: ws.timezone,
    updatedAgents: updated,
    applied: patch,
    summary: `Dials once per day at ${runAt} ${ws.timezone} (window ${start}-${end}), up to ${attempts} days.`,
  });
}
