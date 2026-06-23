// =====================================================================
// GET   /api/agents/:id        — agent detail (configs + recent calls)
// PATCH /api/agents/:id         — update status, direction, linkage,
//                                 per-agent CRM + Retell creds, and/or
//                                 call_config (dialing rules).
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { encryptJson } from "@/lib/crypto";
import {
  callConfigSchema,
  crmCredentialsSchema,
  pipelineStageMapSchema,
  retellCredentialsSchema,
  taskConfigSchema,
} from "@/lib/validation";
import type { AgentDirection } from "@/types";
import type { Database } from "@/types/database";
import { z } from "zod";

export const runtime = "nodejs";

type AgentUpdate = Database["public"]["Tables"]["agents"]["Update"];

type AgentRow = {
  id: string;
  workspace_id: string;
  name: string;
  status: "draft" | "active" | "paused";
  direction: AgentDirection;
  objective: string | null;
  enroll_tag: string | null;
  retell_agent_id: string | null;
  retell_from_number: string | null;
  crm_provider: "followupboss" | "highlevel" | null;
  crm_credentials_encrypted: string | null;
  retell_credentials_encrypted: string | null;
  created_at: string;
  agent_call_configs: unknown[];
  agent_task_configs: unknown[];
};

function publicAgent(agent: AgentRow) {
  const { crm_credentials_encrypted, retell_credentials_encrypted, ...rest } = agent;
  return {
    ...rest,
    has_crm_credentials: Boolean(crm_credentials_encrypted),
    has_retell_credentials: Boolean(retell_credentials_encrypted),
  };
}

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
      "id, workspace_id, name, status, direction, objective, enroll_tag, " +
        "retell_agent_id, retell_from_number, crm_provider, " +
        "crm_credentials_encrypted, retell_credentials_encrypted, created_at, " +
        "agent_call_configs(*), agent_task_configs(*), " +
        "workspaces(timezone, crm_provider, crm_credentials_encrypted)"
    )
    .eq("id", params.id)
    .single<
      AgentRow & {
        workspaces: {
          timezone: string;
          crm_provider: "followupboss" | "highlevel" | null;
          crm_credentials_encrypted: string | null;
        } | null;
      }
    >();

  if (error || !agent) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { workspaces, ...agentRow } = agent;

  // Effective CRM = the agent's own provider/creds when set, otherwise the
  // ones inherited from the workspace. Older workspaces configured HighLevel
  // at the workspace level, so agents there have neither field of their own —
  // the routing editor must key off this, not the agent's own columns.
  const effectiveCrmProvider =
    agentRow.crm_provider ?? workspaces?.crm_provider ?? null;
  const hasEffectiveCrmCredentials =
    Boolean(agentRow.crm_credentials_encrypted) ||
    Boolean(workspaces?.crm_credentials_encrypted);

  const { data: calls } = await db
    .from("calls")
    .select(
      "id, attempt_number, to_number, status, outcome, in_voicemail, " +
        "summary, applied_tag, task_created, queued_at, completed_at"
    )
    .eq("agent_id", params.id)
    .order("queued_at", { ascending: false })
    .limit(50);

  const { data: pipelineStageMap } = await db
    .from("agent_pipeline_stage_map")
    .select("outcome, pipeline_id, pipeline_stage_id, pipeline_name, stage_name")
    .eq("agent_id", params.id);

  return NextResponse.json({
    agent: publicAgent(agentRow),
    workspaceTimezone: workspaces?.timezone ?? "America/New_York",
    effectiveCrmProvider,
    hasEffectiveCrmCredentials,
    calls: calls ?? [],
    pipelineStageMap: pipelineStageMap ?? [],
  });
}

const patchSchema = z.object({
  status: z.enum(["draft", "active", "paused"]).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  enroll_tag: z.string().nullable().optional(),
  retell_agent_id: z.string().nullable().optional(),
  retell_from_number: z.string().nullable().optional(),
  objective: z.string().nullable().optional(),
  crm_provider: z.enum(["followupboss", "highlevel"]).nullable().optional(),
  crm_credentials: crmCredentialsSchema.nullable().optional(),
  retell_credentials: retellCredentialsSchema.nullable().optional(),
  call_config: callConfigSchema.optional(),
  task_config: taskConfigSchema.optional(),
  pipeline_stage_map: pipelineStageMapSchema.optional(),
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

  const input = parsed.data;

  // Authorize: ensure the caller can see this agent under RLS before writing.
  const { data: existing } = await userClient
    .from("agents")
    .select(
      "id, direction, enroll_tag, retell_agent_id, retell_from_number, " +
        "crm_provider, crm_credentials_encrypted, retell_credentials_encrypted"
    )
    .eq("id", params.id)
    .single<{
      id: string;
      direction: AgentDirection;
      enroll_tag: string | null;
      retell_agent_id: string | null;
      retell_from_number: string | null;
      crm_provider: "followupboss" | "highlevel" | null;
      crm_credentials_encrypted: string | null;
      retell_credentials_encrypted: string | null;
    }>();
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const nextDirection = input.direction ?? existing.direction;
  const nextRetellAgentId = input.retell_agent_id ?? existing.retell_agent_id;
  const nextFromNumber = input.retell_from_number ?? existing.retell_from_number;
  const nextCrmProvider = input.crm_provider ?? existing.crm_provider;
  const nextCrmEncrypted = input.crm_credentials
    ? encryptJson(input.crm_credentials)
    : existing.crm_credentials_encrypted;
  const nextRetellEncrypted = input.retell_credentials
    ? encryptJson(input.retell_credentials)
    : existing.retell_credentials_encrypted;

  // Guard: activating requires direction-specific Retell linkage.
  if (input.status === "active") {
    if (!nextRetellAgentId) {
      return NextResponse.json(
        { error: "Cannot activate: agent needs a Retell agent ID first." },
        { status: 400 }
      );
    }
    if (nextDirection === "outbound" && !nextFromNumber) {
      return NextResponse.json(
        {
          error:
            "Cannot activate: outbound agents need a Retell from-number first.",
        },
        { status: 400 }
      );
    }
    if (nextDirection === "inbound" && !nextRetellEncrypted) {
      return NextResponse.json(
        {
          error:
            "Cannot activate: inbound agents need Retell credentials first.",
        },
        { status: 400 }
      );
    }
  }

  const update: AgentUpdate = {};
  if (input.status !== undefined) update.status = input.status;
  if (input.direction !== undefined) update.direction = input.direction;
  if (input.objective !== undefined) update.objective = input.objective;
  if (input.retell_agent_id !== undefined) update.retell_agent_id = input.retell_agent_id;
  if (input.retell_from_number !== undefined) {
    update.retell_from_number = input.retell_from_number;
  }
  if (input.enroll_tag !== undefined) update.enroll_tag = input.enroll_tag;
  if (input.crm_provider !== undefined) update.crm_provider = input.crm_provider;
  if (input.crm_credentials !== undefined) {
    update.crm_credentials_encrypted = nextCrmEncrypted;
  }
  if (input.retell_credentials !== undefined) {
    update.retell_credentials_encrypted = nextRetellEncrypted;
  }

  // Outbound agents need a CRM provider + stored creds when set on the agent.
  if (
    nextDirection === "outbound" &&
    nextCrmProvider &&
    !nextCrmEncrypted &&
    (input.crm_provider !== undefined || input.crm_credentials !== undefined)
  ) {
    return NextResponse.json(
      { error: "CRM credentials are required when setting a CRM provider." },
      { status: 400 }
    );
  }

  const db = createServiceClient();

  if (Object.keys(update).length > 0) {
    const { error: agentError } = await db
      .from("agents")
      .update(update)
      .eq("id", params.id);
    if (agentError) {
      return NextResponse.json({ error: agentError.message }, { status: 500 });
    }
  }

  if (input.call_config) {
    const { error: configError } = await db.from("agent_call_configs").upsert(
      {
        agent_id: params.id,
        ...input.call_config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    );
    if (configError) {
      return NextResponse.json({ error: configError.message }, { status: 500 });
    }
  }

  if (input.task_config) {
    const { error: taskError } = await db.from("agent_task_configs").upsert(
      {
        agent_id: params.id,
        ...input.task_config,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id" }
    );
    if (taskError) {
      return NextResponse.json({ error: taskError.message }, { status: 500 });
    }
  }

  // Pipeline routing map: full replace for this agent. An empty array clears
  // all routing rules; rows present overwrite the stored map.
  if (input.pipeline_stage_map) {
    const { error: deleteError } = await db
      .from("agent_pipeline_stage_map")
      .delete()
      .eq("agent_id", params.id);
    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }
    if (input.pipeline_stage_map.length > 0) {
      const rows = input.pipeline_stage_map.map((entry) => ({
        agent_id: params.id,
        outcome: entry.outcome,
        pipeline_id: entry.pipeline_id,
        pipeline_stage_id: entry.pipeline_stage_id,
        pipeline_name: entry.pipeline_name,
        stage_name: entry.stage_name,
        updated_at: new Date().toISOString(),
      }));
      const { error: insertError } = await db
        .from("agent_pipeline_stage_map")
        .insert(rows);
      if (insertError) {
        return NextResponse.json({ error: insertError.message }, { status: 500 });
      }
    }
  }

  const { data: updated, error } = await db
    .from("agents")
    .select(
      "id, status, direction, objective, enroll_tag, retell_agent_id, " +
        "retell_from_number, crm_provider, crm_credentials_encrypted, " +
        "retell_credentials_encrypted, agent_call_configs(*)"
    )
    .eq("id", params.id)
    .single<AgentRow>();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "not found" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, agent: publicAgent(updated) });
}
