// =====================================================================
// GET   /api/agents/:id        — agent detail (configs + recent calls)
// PATCH /api/agents/:id         — update status (draft|active|paused)
//                                 and/or Retell linkage fields.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: agent, error } = await db
    .from("agents")
    .select(
      "id, workspace_id, name, status, objective, retell_agent_id, " +
        "retell_from_number, created_at, agent_call_configs(*), agent_task_configs(*)"
    )
    .eq("id", params.id)
    .single();

  if (error || !agent) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: calls } = await db
    .from("calls")
    .select(
      "id, attempt_number, to_number, status, outcome, in_voicemail, " +
        "summary, applied_tag, task_created, queued_at, completed_at"
    )
    .eq("agent_id", params.id)
    .order("queued_at", { ascending: false })
    .limit(50);

  return NextResponse.json({ agent, calls: calls ?? [] });
}

const patchSchema = z.object({
  status: z.enum(["draft", "active", "paused"]).optional(),
  retell_agent_id: z.string().nullable().optional(),
  retell_from_number: z.string().nullable().optional(),
  objective: z.string().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // Authorize: ensure the caller can see this agent under RLS before writing.
  const { data: visible } = await userClient
    .from("agents")
    .select("id, retell_agent_id, retell_from_number")
    .eq("id", params.id)
    .single<{ id: string; retell_agent_id: string | null; retell_from_number: string | null }>();
  if (!visible) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Guard: activating requires Retell linkage so the engine can place calls.
  if (parsed.data.status === "active") {
    const willHaveAgentId =
      parsed.data.retell_agent_id ?? visible.retell_agent_id;
    const willHaveFrom =
      parsed.data.retell_from_number ?? visible.retell_from_number;
    if (!willHaveAgentId || !willHaveFrom) {
      return NextResponse.json(
        {
          error:
            "Cannot activate: agent needs a Retell agent ID and from-number first.",
        },
        { status: 400 }
      );
    }
  }

  const db = createServiceClient();
  const { data: updated, error } = await db
    .from("agents")
    .update(parsed.data)
    .eq("id", params.id)
    .select("id, status, retell_agent_id, retell_from_number, objective")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, agent: updated });
}
