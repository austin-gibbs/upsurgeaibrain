// =====================================================================
// POST /api/workspaces/:id/agents — add an agent to an existing workspace.
//
// Creates the agent in draft with its call + task configs. Each agent
// must have a distinct enroll tag so contact segments stay disjoint.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { createAgentSchema } from "@/lib/validation";
import { encryptJson } from "@/lib/crypto";
import type { Agent } from "@/types";

export const runtime = "nodejs";

function effectiveEnrollTag(
  agentEnrollTag: string | null,
  workspaceEnrollTag: string
): string {
  return (agentEnrollTag ?? workspaceEnrollTag).toLowerCase();
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: workspace } = await userClient
    .from("workspaces")
    .select("id, enroll_tag")
    .eq("id", params.id)
    .single<{ id: string; enroll_tag: string }>();
  if (!workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const json = await req.json().catch(() => null);
  const parsed = createAgentSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const db = createServiceClient();

  // Enroll-tag uniqueness only applies to outbound agents — inbound agents
  // answer the line and never enroll contacts, so they carry no enroll tag.
  if (input.direction === "outbound" && input.enroll_tag) {
    const { data: existingAgents } = await db
      .from("agents")
      .select("enroll_tag")
      .eq("workspace_id", params.id)
      .returns<Pick<Agent, "enroll_tag">[]>();

    const newTag = input.enroll_tag.toLowerCase();
    const taken = (existingAgents ?? []).some(
      (a) => effectiveEnrollTag(a.enroll_tag, workspace.enroll_tag) === newTag
    );
    if (taken) {
      return NextResponse.json(
        {
          error:
            "An agent in this workspace already uses that enroll tag. Choose a distinct tag.",
        },
        { status: 409 }
      );
    }
  }

  // Encrypt the per-agent credentials at rest (mirrors workspace CRM creds).
  let crmCredsEncrypted: string | null = null;
  let retellCredsEncrypted: string | null = null;
  try {
    crmCredsEncrypted = input.crm_credentials
      ? encryptJson(input.crm_credentials)
      : null;
    retellCredsEncrypted = input.retell_credentials
      ? encryptJson(input.retell_credentials)
      : null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "encryption failed";
    return NextResponse.json(
      { error: "encryption misconfigured", detail: message },
      { status: 500 }
    );
  }

  const { data: agent, error: agErr } = await db
    .from("agents")
    .insert({
      workspace_id: params.id,
      name: input.name,
      direction: input.direction,
      enroll_tag: input.direction === "outbound" ? input.enroll_tag : null,
      retell_agent_id: input.retell_agent_id,
      retell_from_number: input.retell_from_number,
      objective: input.objective,
      crm_provider: input.crm_provider,
      crm_credentials_encrypted: crmCredsEncrypted,
      retell_credentials_encrypted: retellCredsEncrypted,
      status: "draft",
    })
    .select("id")
    .single<{ id: string }>();
  if (agErr || !agent) {
    return NextResponse.json(
      { error: "failed to create agent", detail: agErr?.message },
      { status: 500 }
    );
  }

  const { error: callCfgErr } = await db
    .from("agent_call_configs")
    .insert({ agent_id: agent.id, ...input.callConfig });
  if (callCfgErr) {
    return NextResponse.json(
      { error: "failed to create agent call config", detail: callCfgErr.message },
      { status: 500 }
    );
  }
  const { error: taskCfgErr } = await db
    .from("agent_task_configs")
    .insert({ agent_id: agent.id, ...input.taskConfig });
  if (taskCfgErr) {
    return NextResponse.json(
      { error: "failed to create agent task config", detail: taskCfgErr.message },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, agentId: agent.id });
}
