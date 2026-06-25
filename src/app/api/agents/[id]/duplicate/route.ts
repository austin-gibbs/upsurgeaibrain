// =====================================================================
// POST /api/agents/:id/duplicate — clone an agent inside its workspace.
//
// Copies call + task configs, pipeline routing, CRM/Retell credentials,
// and Retell linkage. The new agent is always created as draft with a
// user-supplied name and (for outbound) a distinct enroll tag.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { duplicateAgentSchema } from "@/lib/validation";
import {
  assertEnrollTagUnique,
  enrollTagTakenMessage,
  effectiveEnrollTag,
  isEnrollTagUniqueViolation,
} from "@/lib/agents/enroll-tag";
import type { AgentDirection } from "@/types";
import type { Database } from "@/types/database";

type CallOutcome = Database["public"]["Enums"]["call_outcome"];

export const runtime = "nodejs";

type SourceAgent = {
  id: string;
  workspace_id: string;
  name: string;
  direction: AgentDirection;
  objective: string | null;
  enroll_tag: string | null;
  retell_agent_id: string | null;
  retell_from_number: string | null;
  crm_provider: "followupboss" | "highlevel" | null;
  crm_credentials_encrypted: string | null;
  retell_credentials_encrypted: string | null;
  agent_call_configs: Record<string, unknown>[] | Record<string, unknown> | null;
  agent_task_configs: Record<string, unknown>[] | Record<string, unknown> | null;
};

type PipelineRow = {
  outcome: CallOutcome;
  call_attempt: number | null;
  pipeline_id: string;
  pipeline_stage_id: string;
  pipeline_name: string | null;
  stage_name: string | null;
};

function firstRow<T>(embed: T | T[] | null | undefined): T | null {
  if (Array.isArray(embed)) return embed[0] ?? null;
  if (embed && typeof embed === "object") return embed;
  return null;
}

function stripConfigRow(
  row: Record<string, unknown> | null,
  omit: string[]
): Record<string, unknown> {
  if (!row) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!omit.includes(key)) out[key] = value;
  }
  return out;
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

  const { data: authorized } = await userClient
    .from("agents")
    .select("id, workspace_id")
    .eq("id", params.id)
    .single<{ id: string; workspace_id: string }>();
  if (!authorized) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const json = await req.json().catch(() => null);
  const parsed = duplicateAgentSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const input = parsed.data;

  const db = createServiceClient();

  const { data: source, error: sourceErr } = await db
    .from("agents")
    .select(
      "id, workspace_id, name, direction, objective, enroll_tag, " +
        "retell_agent_id, retell_from_number, crm_provider, " +
        "crm_credentials_encrypted, retell_credentials_encrypted, " +
        "agent_call_configs(*), agent_task_configs(*)"
    )
    .eq("id", params.id)
    .single<SourceAgent>();

  if (sourceErr || !source) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const { data: workspace } = await db
    .from("workspaces")
    .select("enroll_tag")
    .eq("id", source.workspace_id)
    .single<{ enroll_tag: string }>();
  if (!workspace) {
    return NextResponse.json({ error: "workspace not found" }, { status: 404 });
  }

  const isOutbound = source.direction === "outbound";
  let enrollTag: string | null = null;

  if (isOutbound) {
    if (!input.enroll_tag || input.enroll_tag.trim().length === 0) {
      return NextResponse.json(
        { error: "Outbound agents need a distinct enrollment tag." },
        { status: 400 }
      );
    }
    enrollTag = input.enroll_tag.trim();
    const enrollError = await assertEnrollTagUnique(
      db,
      source.workspace_id,
      enrollTag,
      workspace.enroll_tag
    );
    if (enrollError) {
      return NextResponse.json({ error: enrollError }, { status: 409 });
    }
  }

  const { data: newAgent, error: insertErr } = await db
    .from("agents")
    .insert({
      workspace_id: source.workspace_id,
      name: input.name.trim(),
      direction: source.direction,
      enroll_tag: enrollTag,
      objective: source.objective,
      retell_agent_id: source.retell_agent_id,
      retell_from_number: source.retell_from_number,
      crm_provider: source.crm_provider,
      crm_credentials_encrypted: source.crm_credentials_encrypted,
      retell_credentials_encrypted: source.retell_credentials_encrypted,
      status: "draft",
    })
    .select("id")
    .single<{ id: string }>();

  if (insertErr || !newAgent) {
    if (isEnrollTagUniqueViolation(insertErr)) {
      const tag = effectiveEnrollTag(enrollTag, workspace.enroll_tag);
      return NextResponse.json({ error: enrollTagTakenMessage(tag) }, { status: 409 });
    }
    return NextResponse.json(
      { error: "failed to duplicate agent", detail: insertErr?.message },
      { status: 500 }
    );
  }

  const callConfig = stripConfigRow(
    firstRow(source.agent_call_configs),
    ["agent_id", "created_at", "updated_at"]
  );
  if (Object.keys(callConfig).length > 0) {
    const { error: callErr } = await db
      .from("agent_call_configs")
      .insert({ agent_id: newAgent.id, ...callConfig });
    if (callErr) {
      await db.from("agents").delete().eq("id", newAgent.id);
      return NextResponse.json(
        { error: "failed to copy call config", detail: callErr.message },
        { status: 500 }
      );
    }
  }

  const taskConfig = stripConfigRow(
    firstRow(source.agent_task_configs),
    ["agent_id", "created_at", "updated_at"]
  );
  if (Object.keys(taskConfig).length > 0) {
    const { error: taskErr } = await db
      .from("agent_task_configs")
      .insert({ agent_id: newAgent.id, ...taskConfig });
    if (taskErr) {
      await db.from("agents").delete().eq("id", newAgent.id);
      return NextResponse.json(
        { error: "failed to copy task config", detail: taskErr.message },
        { status: 500 }
      );
    }
  }

  const { data: pipelineRows } = await db
    .from("agent_pipeline_stage_map")
    .select(
      "outcome, call_attempt, pipeline_id, pipeline_stage_id, pipeline_name, stage_name"
    )
    .eq("agent_id", params.id)
    .returns<PipelineRow[]>();

  if (pipelineRows && pipelineRows.length > 0) {
    const { error: mapErr } = await db.from("agent_pipeline_stage_map").insert(
      pipelineRows.map((row) => ({
        agent_id: newAgent.id,
        outcome: row.outcome,
        call_attempt: row.call_attempt,
        pipeline_id: row.pipeline_id,
        pipeline_stage_id: row.pipeline_stage_id,
        pipeline_name: row.pipeline_name,
        stage_name: row.stage_name,
      }))
    );
    if (mapErr) {
      await db.from("agents").delete().eq("id", newAgent.id);
      return NextResponse.json(
        { error: "failed to copy pipeline routing", detail: mapErr.message },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true, agentId: newAgent.id });
}
