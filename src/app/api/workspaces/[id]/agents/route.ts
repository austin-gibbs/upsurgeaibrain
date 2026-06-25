// =====================================================================
// POST /api/workspaces/:id/agents — add an agent to an existing workspace.
//
// Creates the agent in draft with its call + task configs. Each outbound
// agent must have a distinct enroll tag. Agents may inherit workspace CRM
// credentials instead of storing a duplicate HighLevel OAuth copy.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { createAgentSchema } from "@/lib/validation";
import { encryptJson } from "@/lib/crypto";
import {
  assertEnrollTagUnique,
  enrollTagTakenMessage,
  effectiveEnrollTag,
  isEnrollTagUniqueViolation,
} from "@/lib/agents/enroll-tag";
import {
  hasEffectiveCrmCredentials,
  workspaceHasCrmCredentials,
} from "@/lib/agents/crm-inheritance";

export const runtime = "nodejs";

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
    .select("id, enroll_tag, crm_provider, crm_credentials_encrypted")
    .eq("id", params.id)
    .single<{
      id: string;
      enroll_tag: string;
      crm_provider: "followupboss" | "highlevel" | null;
      crm_credentials_encrypted: string | null;
    }>();
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

  const inheritsCrm =
    input.inherit_workspace_crm ||
    (!input.crm_provider && !input.crm_credentials);

  if (inheritsCrm && !workspaceHasCrmCredentials(workspace)) {
    return NextResponse.json(
      {
        error:
          "This workspace has no CRM connection yet. Connect CRM at the workspace level or provide per-agent credentials.",
      },
      { status: 400 }
    );
  }

  const db = createServiceClient();

  if (input.direction === "outbound" && input.enroll_tag) {
    const enrollError = await assertEnrollTagUnique(
      db,
      params.id,
      input.enroll_tag,
      workspace.enroll_tag
    );
    if (enrollError) {
      return NextResponse.json({ error: enrollError }, { status: 409 });
    }
  }

  let crmCredsEncrypted: string | null = null;
  let retellCredsEncrypted: string | null = null;
  let crmProvider: "followupboss" | "highlevel" | null = null;

  if (inheritsCrm) {
    crmProvider = null;
    crmCredsEncrypted = null;
  } else {
    crmProvider = input.crm_provider;
    try {
      crmCredsEncrypted = input.crm_credentials
        ? encryptJson(input.crm_credentials)
        : null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "encryption failed";
      return NextResponse.json(
        { error: "encryption misconfigured", detail: message },
        { status: 500 }
      );
    }
  }

  try {
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
      crm_provider: crmProvider,
      crm_credentials_encrypted: crmCredsEncrypted,
      retell_credentials_encrypted: retellCredsEncrypted,
      status: "draft",
    })
    .select("id")
    .single<{ id: string }>();
  if (agErr || !agent) {
    if (isEnrollTagUniqueViolation(agErr)) {
      const tag = effectiveEnrollTag(input.enroll_tag, workspace.enroll_tag);
      return NextResponse.json({ error: enrollTagTakenMessage(tag) }, { status: 409 });
    }
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

  return NextResponse.json({
    ok: true,
    agentId: agent.id,
    inheritsWorkspaceCrm: inheritsCrm,
    hasEffectiveCrm: hasEffectiveCrmCredentials(
      { crm_provider: crmProvider, crm_credentials_encrypted: crmCredsEncrypted },
      workspace
    ),
  });
}
