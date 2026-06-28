// =====================================================================
// POST /api/console/activate
//
// Run the SAME activation invariants the app's agent PATCH uses
// (validateAgentActivation), then flip qualifying agents in a workspace to
// "active". Use after the admin connects CRM in the app — connecting CRM does
// NOT auto-activate. Mirrors scripts/activate-agent.ts. Session + admin gated.
//
// Body: { workspace: <name>, dryRun?: boolean }.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { validateAgentActivation } from "@/lib/agents/activation";
import { bindRetellWebhookForAgentSafe } from "@/lib/retell/webhook-bind";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentRow = {
  id: string;
  name: string;
  status: string;
  direction: "inbound" | "outbound";
  enroll_tag: string | null;
  retell_agent_id: string | null;
  retell_from_number: string | null;
  retell_credentials_encrypted: string | null;
  crm_provider: "followupboss" | "highlevel" | null;
  crm_credentials_encrypted: string | null;
};

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const json = await req.json().catch(() => null);
  const workspaceName =
    json && typeof json === "object"
      ? String((json as { workspace?: unknown }).workspace ?? "").trim()
      : "";
  const dryRun = Boolean(
    json && typeof json === "object" && (json as { dryRun?: unknown }).dryRun
  );
  if (!workspaceName) {
    return NextResponse.json(
      { error: "missing { workspace: <name> }" },
      { status: 400 }
    );
  }

  const db = createServiceClient();

  const { data: workspaces, error: wsErr } = await db
    .from("workspaces")
    .select(
      "id, name, enroll_tag, crm_provider, crm_credentials_encrypted, created_at"
    )
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
  const ws = workspaces[0] as {
    id: string;
    name: string;
    enroll_tag: string;
    crm_provider: "followupboss" | "highlevel" | null;
    crm_credentials_encrypted: string | null;
  };

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select(
      "id, name, status, direction, enroll_tag, retell_agent_id, " +
        "retell_from_number, retell_credentials_encrypted, crm_provider, " +
        "crm_credentials_encrypted"
    )
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

  const rows = agents as unknown as AgentRow[];
  const peerRows = rows.map((a) => ({
    id: a.id,
    direction: a.direction,
    enroll_tag: a.enroll_tag,
  }));

  const results: Array<{ agent: string; result: string }> = [];

  for (const a of rows) {
    if (a.status === "active") {
      results.push({ agent: a.name, result: "already active" });
      continue;
    }

    const { data: callConfigRow } = await db
      .from("agent_call_configs")
      .select("agent_id")
      .eq("agent_id", a.id)
      .maybeSingle();

    const blocked = validateAgentActivation({
      agentId: a.id,
      direction: a.direction,
      enrollTag: a.enroll_tag,
      retellAgentId: a.retell_agent_id,
      retellFromNumber: a.retell_from_number,
      retellCredentialsEncrypted: a.retell_credentials_encrypted,
      workspaceEnrollTag: ws.enroll_tag,
      existingAgents: peerRows,
      agent: {
        crm_provider: a.crm_provider,
        crm_credentials_encrypted: a.crm_credentials_encrypted,
      },
      workspace: {
        crm_provider: ws.crm_provider,
        crm_credentials_encrypted: ws.crm_credentials_encrypted,
      },
      hasCallConfig: Boolean(callConfigRow),
    });

    if (blocked) {
      results.push({ agent: a.name, result: `BLOCKED — ${blocked}` });
      continue;
    }

    if (dryRun) {
      results.push({ agent: a.name, result: "would activate" });
      continue;
    }

    await bindRetellWebhookForAgentSafe({
      id: a.id,
      retell_agent_id: a.retell_agent_id,
      retell_credentials_encrypted: a.retell_credentials_encrypted,
    });

    const { error } = await db
      .from("agents")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", a.id);
    if (error) {
      results.push({ agent: a.name, result: `update failed — ${error.message}` });
      continue;
    }
    results.push({ agent: a.name, result: "ACTIVATED" });
  }

  return NextResponse.json({ ok: true, dryRun, workspace: ws.name, results });
}
