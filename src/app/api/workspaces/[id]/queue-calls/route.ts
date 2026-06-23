// =====================================================================
// POST /api/workspaces/:id/queue-calls — bulk re-enqueue a hand-picked set
// of enrolled contacts into the live call queue right now, drip-spaced at the
// agent's drip_seconds. Powers the Ops "Queue calls now" multi-select action.
//
// Unlike "Run poll" this does NOT scan the CRM (the contact IDs are already
// known), so it returns instantly with no serverless-timeout risk. It honors
// the call window and caps the batch to what fits before the window closes.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { enqueueContactsNow } from "@/lib/engine/poller";
import { queueCallsSchema } from "@/lib/validation";

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

  // RLS scopes this to workspaces the caller can see.
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
  const parsed = queueCallsSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { agentId, contactIds } = parsed.data;

  // Confirm the agent is an outbound agent that belongs to this workspace.
  const { data: agent } = await db
    .from("agents")
    .select("id, direction")
    .eq("id", agentId)
    .eq("workspace_id", params.id)
    .single<{ id: string; direction: "inbound" | "outbound" }>();
  if (!agent) {
    return NextResponse.json(
      { error: "agent not found in this workspace" },
      { status: 404 }
    );
  }
  if (agent.direction !== "outbound") {
    return NextResponse.json(
      { error: "only outbound agents can place calls" },
      { status: 400 }
    );
  }

  const result = await enqueueContactsNow(agentId, contactIds);
  return NextResponse.json({ ok: result.enqueued > 0, ...result });
}
