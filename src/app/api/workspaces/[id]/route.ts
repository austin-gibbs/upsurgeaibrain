// =====================================================================
// GET /api/workspaces/:id — workspace detail: agents + their configs,
// recent calls, and contact counts. RLS scopes to the caller's orgs.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

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
    .single();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: agents } = await db
    .from("agents")
    .select(
      "id, name, status, objective, retell_agent_id, retell_from_number, " +
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
    workspace,
    agents: agents ?? [],
    contactCount: contactCount ?? 0,
    contacts: contacts ?? [],
    outcomeTags: tags ?? [],
  });
}
