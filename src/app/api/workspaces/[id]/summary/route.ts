// =====================================================================
// GET /api/workspaces/:id/summary — lightweight workspace header data
// for dashboard/nav without loading the full contact list.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { normalizeCallConfigList, normalizeEmbedList } from "@/lib/hhmm";

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
    .select(
      "id, name, timezone, crm_provider, enroll_tag, is_active, created_at, crm_account_url, crm_status, crm_credentials_encrypted"
    )
    .eq("id", params.id)
    .single<{
      id: string;
      name: string;
      timezone: string;
      crm_provider: "followupboss" | "highlevel";
      enroll_tag: string;
      is_active: boolean;
      created_at: string;
      crm_account_url: string | null;
      crm_status: string | null;
      crm_credentials_encrypted: string | null;
    }>();

  if (wsErr || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: agentsRaw } = await db
    .from("agents")
    .select(
      "id, name, status, direction, objective, enroll_tag, retell_agent_id, " +
        "agent_call_configs(*), agent_task_configs(*)"
    )
    .eq("workspace_id", params.id)
    .order("created_at", { ascending: true })
    .returns<
      {
        id: string;
        name: string;
        status: string;
        direction: string;
        objective: string | null;
        enroll_tag: string | null;
        retell_agent_id: string | null;
        agent_call_configs: unknown;
        agent_task_configs: unknown;
      }[]
    >();

  const agents = (agentsRaw ?? []).map((agent) => ({
    ...agent,
    agent_call_configs: normalizeCallConfigList(agent.agent_call_configs),
    agent_task_configs: normalizeEmbedList(agent.agent_task_configs),
  }));

  const { count: contactCount } = await db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", params.id);

  const tasksEnabled =
    agents.length > 0 &&
    agents.every((a) => {
      const tc = Array.isArray(a.agent_task_configs)
        ? a.agent_task_configs[0]
        : a.agent_task_configs;
      return Boolean(tc && typeof tc === "object" && (tc as { enabled?: boolean }).enabled);
    });

  const { crm_credentials_encrypted, crm_status, ...workspacePublic } = workspace;

  return NextResponse.json({
    workspace: {
      ...workspacePublic,
      crm_status: crm_status ?? null,
      has_workspace_crm_credentials: Boolean(crm_credentials_encrypted),
    },
    agents,
    contactCount: contactCount ?? 0,
    tasksEnabled,
  });
}
