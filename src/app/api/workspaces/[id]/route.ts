// =====================================================================
// GET /api/workspaces/:id — workspace detail: agents + their configs,
// recent calls, and contact counts. RLS scopes to the caller's orgs.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { z } from "zod";
import { crmAccountUrlSchema } from "@/lib/validation";

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

  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, timezone, crm_provider, enroll_tag, is_active, created_at")
    .eq("id", params.id)
    .single<{
      id: string;
      name: string;
      timezone: string;
      crm_provider: "followupboss" | "highlevel";
      enroll_tag: string;
      is_active: boolean;
      created_at: string;
    }>();

  if (wsErr || !workspace) {
    console.error("workspace fetch failed", { id: params.id, error: wsErr?.message });
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: agents } = await db
    .from("agents")
    .select(
      "id, name, status, direction, objective, enroll_tag, retell_agent_id, retell_from_number, " +
        "agent_call_configs(*), agent_task_configs(*)"
    )
    .eq("workspace_id", params.id)
    .order("created_at", { ascending: true });

  const { count: contactCount } = await db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", params.id);

  // Per-contact cadence state so the dashboard can show when each contact's
  // next call is scheduled. Active contacts (soonest next call first) come
  // before terminal/finished ones.
  const { data: contacts } = await db
    .from("contacts")
    .select(
      "id, full_name, phones, attempt_count, last_called_on, next_eligible_on, is_terminal, terminal_outcome"
    )
    .eq("workspace_id", params.id)
    .order("is_terminal", { ascending: true })
    .order("next_eligible_on", { ascending: true, nullsFirst: true })
    .limit(1000);

  const { data: tags } = await db
    .from("workspace_outcome_tags")
    .select("outcome, tag, is_terminal")
    .eq("workspace_id", params.id);

  return NextResponse.json({
    workspace: { ...workspace, crm_account_url: null },
    agents: agents ?? [],
    contactCount: contactCount ?? 0,
    contacts: contacts ?? [],
    outcomeTags: tags ?? [],
  });
}

// PATCH /api/workspaces/:id — workspace-level controls. Currently a single
// switch that turns follow-up task creation on/off for every agent in the
// workspace (flips each agent_task_configs.enabled).
const patchSchema = z.object({
  tasks_enabled: z.boolean().optional(),
  crm_account_url: crmAccountUrlSchema,
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

  // Authorize: ensure the caller can see this workspace under RLS before writing.
  const { data: workspace } = await userClient
    .from("workspaces")
    .select("id")
    .eq("id", params.id)
    .single<{ id: string }>();
  if (!workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const db = createServiceClient();

  if (parsed.data.tasks_enabled !== undefined) {
    const { data: agents } = await db
      .from("agents")
      .select("id")
      .eq("workspace_id", params.id)
      .returns<{ id: string }[]>();
    const agentIds = (agents ?? []).map((a) => a.id);

    if (agentIds.length > 0) {
      const { error } = await db
        .from("agent_task_configs")
        .update({ enabled: parsed.data.tasks_enabled })
        .in("agent_id", agentIds);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }
  }

  if (parsed.data.crm_account_url !== undefined) {
    const { error } = await db
      .from("workspaces")
      .update({ crm_account_url: parsed.data.crm_account_url })
      .eq("id", params.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const { data: agents } = await db
    .from("agents")
    .select("id")
    .eq("workspace_id", params.id)
    .returns<{ id: string }[]>();

  return NextResponse.json({
    ok: true,
    tasks_enabled: parsed.data.tasks_enabled,
    crm_account_url: parsed.data.crm_account_url,
    agents_updated: parsed.data.tasks_enabled !== undefined ? (agents ?? []).length : undefined,
  });
}
