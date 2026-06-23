// =====================================================================
// POST /api/workspaces  — provision a workspace from the setup wizard.
//
// This is wizard STEP 5 ("the workflows get created"). It:
//   1. authenticates the user
//   2. validates the payload
//   3. verifies the CRM credentials are live
//   4. creates org (if needed) + workspace (encrypting creds)
//   5. seeds the 7-tag taxonomy
//   6. creates each agent + its call config + task config
//
// Agents are created in `draft`. Activate them from the workspace page to
// turn the engine on for that workspace.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { provisionWorkspaceSchema } from "@/lib/validation";
import { buildAdapter } from "@/lib/crm";
import { encryptJson } from "@/lib/crypto";

export const runtime = "nodejs";

// ---------------------------------------------------------------------
// GET /api/workspaces — list workspaces the signed-in user can see.
// RLS on the user client scopes results to the caller's org memberships.
// ---------------------------------------------------------------------
export async function GET() {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: workspaces, error } = await userClient
    .from("workspaces")
    .select(
      "id, name, timezone, crm_provider, enroll_tag, is_active, created_at, agents(id, name, status, enroll_tag)"
    )
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ workspaces: workspaces ?? [] });
}

export async function POST(req: NextRequest) {
  // 1. Auth
  const userClient = createServerClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // 2. Validate
  const json = await req.json().catch(() => null);
  const parsed = provisionWorkspaceSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", issues: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;

  // 3. Verify CRM creds before persisting anything.
  const adapter = buildAdapter(input.workspace.crm_provider, input.workspace.credentials as any);
  const credsOk = await adapter.verifyCredentials();
  if (!credsOk) {
    return NextResponse.json({ error: "CRM credentials failed verification" }, { status: 400 });
  }

  // Use the service client for writes so multi-table provisioning isn't
  // tripped up by RLS mid-transaction; we've already authorized the user.
  const db = createServiceClient();

  // Ensure profile exists (defensive — trigger normally handles this).
  await db.from("profiles").upsert({ id: user.id, email: user.email ?? "" }, { onConflict: "id" });

  // 4a. Resolve organization.
  let organizationId = input.organizationId ?? null;
  if (!organizationId) {
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({ name: input.organizationName ?? `${input.workspace.name} Org`, created_by: user.id })
      .select("id")
      .single<{ id: string }>();
    if (orgErr || !org) {
      return NextResponse.json({ error: "failed to create organization", detail: orgErr?.message }, { status: 500 });
    }
    organizationId = org.id;
    await db.from("organization_members").upsert({
      organization_id: organizationId, user_id: user.id, role: "owner",
    });
  }

  // 4b. Create workspace with encrypted credentials.
  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .insert({
      organization_id: organizationId,
      name: input.workspace.name,
      timezone: input.workspace.timezone,
      crm_provider: input.workspace.crm_provider,
      crm_credentials_encrypted: encryptJson(input.workspace.credentials),
      enroll_tag: input.workspace.enroll_tag,
      crm_account_url: input.workspace.crm_account_url ?? null,
      created_by: user.id,
    })
    .select("id")
    .single<{ id: string }>();
  if (wsErr || !workspace) {
    return NextResponse.json({ error: "failed to create workspace", detail: wsErr?.message }, { status: 500 });
  }

  // 5. Seed default outcome-tag taxonomy.
  await db.rpc("seed_default_outcome_tags", { p_workspace_id: workspace.id });

  // 6. Create agents + configs.
  const createdAgents: string[] = [];
  for (const a of input.agents) {
    const { data: agent, error: agErr } = await db
      .from("agents")
      .insert({
        workspace_id: workspace.id,
        name: a.name,
        enroll_tag: a.enroll_tag,
        retell_agent_id: a.retell_agent_id,
        retell_from_number: a.retell_from_number,
        objective: a.objective,
        status: "draft",
      })
      .select("id")
      .single<{ id: string }>();
    if (agErr || !agent) {
      return NextResponse.json({ error: "failed to create agent", detail: agErr?.message }, { status: 500 });
    }
    await db.from("agent_call_configs").insert({ agent_id: agent.id, ...a.callConfig });
    await db.from("agent_task_configs").insert({ agent_id: agent.id, ...a.taskConfig });
    createdAgents.push(agent.id);
  }

  return NextResponse.json({
    ok: true,
    organizationId,
    workspaceId: workspace.id,
    agentIds: createdAgents,
  });
}
