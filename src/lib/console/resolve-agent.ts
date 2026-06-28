// =====================================================================
// Resolve a single agent (and its workspace) by workspace NAME + optional
// agent NAME, for the admin console's manage-existing routes. Uses the
// service client (admin-gated upstream), so it bypasses RLS.
//
// - Workspace: newest row matching the name (names aren't unique).
// - Agent: if an agent name is given, match it; otherwise require exactly one
//   agent in the workspace and use it. With multiple agents and no name, the
//   error lists the available agent names so the caller can disambiguate.
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Agent, Workspace } from "@/types";

export type ResolveAgentResult =
  | { ok: true; agent: Agent; workspace: Workspace }
  | { ok: false; status: number; error: string };

export async function resolveConsoleWorkspace(
  db: SupabaseClient,
  workspaceName: string
): Promise<{ ok: true; workspace: Workspace } | { ok: false; status: number; error: string }> {
  const { data: workspaces, error } = await db
    .from("workspaces")
    .select("*")
    .eq("name", workspaceName)
    .order("created_at", { ascending: false });
  if (error) return { ok: false, status: 500, error: error.message };
  if (!workspaces || workspaces.length === 0) {
    return { ok: false, status: 404, error: `No workspace named "${workspaceName}" found.` };
  }
  return { ok: true, workspace: workspaces[0] as unknown as Workspace };
}

export async function resolveConsoleAgent(
  db: SupabaseClient,
  workspaceName: string,
  agentName?: string
): Promise<ResolveAgentResult> {
  const ws = await resolveConsoleWorkspace(db, workspaceName);
  if (!ws.ok) return ws;
  const workspace = ws.workspace;

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select("*")
    .eq("workspace_id", workspace.id);
  if (agErr) return { ok: false, status: 500, error: agErr.message };

  const rows = (agents ?? []) as unknown as Agent[];
  if (rows.length === 0) {
    return { ok: false, status: 404, error: `No agents in workspace "${workspace.name}".` };
  }

  let agent: Agent | undefined;
  if (agentName) {
    agent = rows.find((a) => a.name === agentName);
    if (!agent) {
      return {
        ok: false,
        status: 404,
        error: `No agent named "${agentName}" in "${workspace.name}". Available: ${rows
          .map((a) => a.name)
          .join(", ")}.`,
      };
    }
  } else if (rows.length === 1) {
    agent = rows[0];
  } else {
    return {
      ok: false,
      status: 400,
      error: `Workspace "${workspace.name}" has ${rows.length} agents — pass an agent name. Available: ${rows
        .map((a) => a.name)
        .join(", ")}.`,
    };
  }

  return { ok: true, agent, workspace };
}
