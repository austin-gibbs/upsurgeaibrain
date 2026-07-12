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
import {
  normalizeCallConfigList,
  normalizeHHMM,
  normalizeTaskConfigList,
} from "@/lib/hhmm";
import { listActiveQueueEntries } from "@/lib/engine/call-queue";
import { crmContactUrl } from "@/lib/crm/url";
import { rescheduleAgentCallQueue } from "@/lib/queue/reschedule";
import { prepareTaskConfigForSave } from "@/lib/task-config";
import { defaultTaskConfig } from "@/components/agent-form/types";
import {
  assertEnrollTagUnique,
  enrollTagTakenMessage,
  effectiveEnrollTag,
  isEnrollTagUniqueViolation,
} from "@/lib/agents/enroll-tag";
import {
  agentInheritsWorkspaceCrm,
  effectiveCrmProvider as resolveEffectiveCrmProvider,
  hasEffectiveCrmCredentials as resolveHasEffectiveCrmCredentials,
  workspaceHasCrmCredentials,
} from "@/lib/agents/crm-inheritance";
import { validateAgentActivation } from "@/lib/agents/activation";
import { bindRetellWebhookForAgentSafe } from "@/lib/retell/webhook-bind";
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
  crm_status: string | null;
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
        "retell_agent_id, retell_from_number, crm_provider, crm_status, " +
        "crm_credentials_encrypted, retell_credentials_encrypted, created_at, " +
        "agent_call_configs(*), agent_task_configs(*), " +
        "workspaces(timezone, crm_provider, crm_status, crm_account_url, crm_credentials_encrypted)"
    )
    .eq("id", params.id)
    .single<
      AgentRow & {
        workspaces: {
          timezone: string;
          crm_provider: "followupboss" | "highlevel" | null;
          crm_status: string | null;
          crm_account_url: string | null;
          crm_credentials_encrypted: string | null;
        } | null;
      }
    >();

  if (error || !agent) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { workspaces, ...agentRow } = agent;

  const workspaceCarrier = {
    crm_provider: workspaces?.crm_provider ?? null,
    crm_credentials_encrypted: workspaces?.crm_credentials_encrypted ?? null,
  };
  const effectiveCrmProvider = resolveEffectiveCrmProvider(
    agentRow,
    workspaceCarrier
  );
  const hasEffectiveCrmCredentials = resolveHasEffectiveCrmCredentials(
    agentRow,
    workspaceCarrier
  );
  // CRM connection health for the connection the engine will actually use.
  const usesWorkspaceCrm = workspaceHasCrmCredentials(workspaceCarrier);
  const effectiveCrmStatus =
    usesWorkspaceCrm ? workspaces?.crm_status ?? null : agentRow.crm_status ?? null;

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
    .select(
      "outcome, call_attempt, pipeline_id, pipeline_stage_id, pipeline_name, stage_name"
    )
    .eq("agent_id", params.id);

  const queueRows = await listActiveQueueEntries(createServiceClient(), agentRow.workspace_id);
  const scheduledCalls = queueRows
    .filter((row) => row.agent_id === params.id)
    .map((row) => {
      const phoneNumbers =
        row.phone_numbers?.length > 0
          ? row.phone_numbers
          : row.contacts?.phones ?? [];
      const phoneIndex = row.next_phone_index ?? 0;
      const crmProvider = effectiveCrmProvider ?? workspaces?.crm_provider ?? null;
      return {
        id: row.id,
        contactId: row.contact_id,
        contactName: row.contacts?.full_name ?? "Unknown contact",
        phone: phoneNumbers[phoneIndex] ?? phoneNumbers[0] ?? null,
        phoneIndex,
        phoneCount: phoneNumbers.length,
        status: row.status,
        position: row.position,
        scheduledFor: row.scheduled_for,
        enqueuedAt: row.enqueued_at,
        startedAt: row.started_at,
        callId: row.call_id,
        attemptNumber: row.attempt_number,
        crmUrl:
          crmProvider && row.contacts?.crm_contact_id
            ? crmContactUrl(
                crmProvider,
                workspaces?.crm_account_url ?? null,
                row.contacts.crm_contact_id
              )
            : null,
      };
    });

  const normalizedAgent = {
    ...publicAgent(agentRow),
    agent_call_configs: normalizeCallConfigList(agentRow.agent_call_configs),
    agent_task_configs: normalizeTaskConfigList(agentRow.agent_task_configs),
  };

  return NextResponse.json({
    agent: normalizedAgent,
    workspaceTimezone: workspaces?.timezone ?? "America/New_York",
    effectiveCrmProvider,
    hasEffectiveCrmCredentials,
    effectiveCrmStatus,
    inheritsWorkspaceCrm: agentInheritsWorkspaceCrm(agentRow, workspaceCarrier),
    workspaceHasCrmCredentials: usesWorkspaceCrm,
    calls: calls ?? [],
    pipelineStageMap: pipelineStageMap ?? [],
    scheduledCalls,
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
  inherit_workspace_crm: z.boolean().optional(),
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
  const body =
    json && typeof json === "object"
      ? {
          ...json,
          ...(json.task_config && typeof json.task_config === "object"
            ? {
                task_config: prepareTaskConfigForSave({
                  ...defaultTaskConfig(),
                  ...json.task_config,
                }),
              }
            : {}),
        }
      : json;
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message ?? "invalid payload";
    return NextResponse.json(
      { error: message, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const input = parsed.data;

  // Authorize: ensure the caller can see this agent under RLS before writing.
  const { data: existing } = await userClient
    .from("agents")
    .select(
      "id, workspace_id, direction, enroll_tag, retell_agent_id, retell_from_number, " +
        "crm_provider, crm_credentials_encrypted, retell_credentials_encrypted, " +
        "workspaces(enroll_tag, crm_provider, crm_credentials_encrypted)"
    )
    .eq("id", params.id)
    .single<{
      id: string;
      workspace_id: string;
      direction: AgentDirection;
      enroll_tag: string | null;
      retell_agent_id: string | null;
      retell_from_number: string | null;
      crm_provider: "followupboss" | "highlevel" | null;
      crm_credentials_encrypted: string | null;
      retell_credentials_encrypted: string | null;
      workspaces: {
        enroll_tag: string;
        crm_provider: "followupboss" | "highlevel" | null;
        crm_credentials_encrypted: string | null;
      } | null;
    }>();
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const workspace = existing.workspaces;
  if (!workspace) {
    return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  }

  const nextDirection = input.direction ?? existing.direction;
  const nextRetellAgentId = input.retell_agent_id ?? existing.retell_agent_id;
  const nextFromNumber = input.retell_from_number ?? existing.retell_from_number;
  const nextEnrollTag =
    input.enroll_tag !== undefined ? input.enroll_tag : existing.enroll_tag;

  let nextCrmProvider = input.crm_provider ?? existing.crm_provider;
  let nextCrmEncrypted = existing.crm_credentials_encrypted;

  if (input.inherit_workspace_crm) {
    if (!workspace.crm_credentials_encrypted) {
      return NextResponse.json(
        {
          error:
            "Workspace has no CRM connection to inherit. Connect CRM at the workspace level first.",
        },
        { status: 400 }
      );
    }
    nextCrmProvider = null;
    nextCrmEncrypted = null;
  } else if (input.crm_credentials) {
    nextCrmEncrypted = encryptJson(input.crm_credentials);
    if (input.crm_provider !== undefined) {
      nextCrmProvider = input.crm_provider;
    }
  } else if (input.crm_provider !== undefined) {
    nextCrmProvider = input.crm_provider;
  }

  const nextRetellEncrypted = input.retell_credentials
    ? encryptJson(input.retell_credentials)
    : existing.retell_credentials_encrypted;

  const db = createServiceClient();

  if (
    nextDirection === "outbound" &&
    nextEnrollTag?.trim() &&
    (input.enroll_tag !== undefined || input.direction !== undefined)
  ) {
    const enrollError = await assertEnrollTagUnique(
      db,
      existing.workspace_id,
      nextEnrollTag,
      workspace.enroll_tag,
      params.id
    );
    if (enrollError) {
      return NextResponse.json({ error: enrollError }, { status: 409 });
    }
  }

  if (input.status === "active") {
    const { data: callConfigRow } = await db
      .from("agent_call_configs")
      .select("agent_id")
      .eq("agent_id", params.id)
      .maybeSingle();

    const { data: peerAgents } = await db
      .from("agents")
      .select("id, direction, enroll_tag")
      .eq("workspace_id", existing.workspace_id)
      .returns<{ id: string; direction: "inbound" | "outbound"; enroll_tag: string | null }[]>();

    const activationError = validateAgentActivation({
      agentId: params.id,
      direction: nextDirection,
      enrollTag: nextEnrollTag,
      retellAgentId: nextRetellAgentId,
      retellFromNumber: nextFromNumber,
      retellCredentialsEncrypted: nextRetellEncrypted,
      workspaceEnrollTag: workspace.enroll_tag,
      existingAgents: peerAgents ?? [],
      agent: {
        crm_provider: nextCrmProvider,
        crm_credentials_encrypted: nextCrmEncrypted,
      },
      workspace: {
        crm_provider: workspace.crm_provider,
        crm_credentials_encrypted: workspace.crm_credentials_encrypted,
      },
      hasCallConfig: Boolean(callConfigRow),
    });
    if (activationError) {
      return NextResponse.json({ error: activationError }, { status: 400 });
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
  if (input.inherit_workspace_crm || input.crm_provider !== undefined) {
    update.crm_provider = nextCrmProvider;
  }
  if (input.inherit_workspace_crm || input.crm_credentials !== undefined) {
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

  if (Object.keys(update).length > 0) {
    if (input.status === "active") {
      await bindRetellWebhookForAgentSafe({
        id: params.id,
        retell_agent_id: nextRetellAgentId,
        retell_credentials_encrypted: nextRetellEncrypted,
      });
    }

    const { error: agentError } = await db
      .from("agents")
      .update(update)
      .eq("id", params.id);
    if (agentError) {
      if (isEnrollTagUniqueViolation(agentError)) {
        const tag = effectiveEnrollTag(nextEnrollTag, workspace.enroll_tag);
        return NextResponse.json({ error: enrollTagTakenMessage(tag) }, { status: 409 });
      }
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

  let queueRescheduled = 0;
  if (input.call_config) {
    try {
      queueRescheduled = await rescheduleAgentCallQueue(params.id);
    } catch (err) {
      console.error(
        `[agents/${params.id}] failed to reschedule call queue:`,
        err
      );
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
  let savedPipelineStageMap:
    | {
        outcome: string;
        call_attempt: number | null;
        pipeline_id: string;
        pipeline_stage_id: string;
        pipeline_name: string | null;
        stage_name: string | null;
      }[]
    | undefined;
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
        call_attempt: entry.call_attempt,
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
    const { data: pipelineStageMap } = await db
      .from("agent_pipeline_stage_map")
      .select(
        "outcome, call_attempt, pipeline_id, pipeline_stage_id, pipeline_name, stage_name"
      )
      .eq("agent_id", params.id);
    savedPipelineStageMap = pipelineStageMap ?? [];
  }

  let savedTaskConfig: Record<string, unknown> | undefined;
  if (input.task_config) {
    // Echo the validated payload we just wrote — avoids a re-read race or
    // PostgREST schema-cache gaps that can omit newer columns in SELECT *.
    savedTaskConfig = {
      agent_id: params.id,
      ...input.task_config,
    };
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
  const agent = publicAgent(updated);
  return NextResponse.json({
    ok: true,
    agent: {
      ...agent,
      agent_call_configs: normalizeCallConfigList(updated.agent_call_configs),
    },
    queueRescheduled,
    ...(savedTaskConfig ? { taskConfig: savedTaskConfig } : {}),
    ...(savedPipelineStageMap ? { pipelineStageMap: savedPipelineStageMap } : {}),
  });
}
