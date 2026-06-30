// =====================================================================
// /api/console/agent-config
//
// Read or edit an EXISTING agent's call settings, task/automation config, and
// HighLevel outcome->stage routing map — keyed by workspace + agent NAME, so
// Claude/the admin can "go into an account and make changes" without the
// terminal. Mirrors the write logic of PATCH /api/agents/[id]. Admin gated.
//
// GET  ?workspace=<name>&agent=<name?>  -> current callConfig, taskConfig,
//      pipelineStageMap, plus effective CRM provider.
// POST { workspace, agent?, callConfig?, taskConfig?, pipelineStageMap? }
//      -> patch any provided section. callConfig/taskConfig MERGE over the
//      existing row (unspecified keys are preserved); pipelineStageMap is
//      REPLACE-ALL (pass [] to clear). Only the sections you send are touched.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import {
  callConfigSchema,
  taskConfigSchema,
  pipelineStageMapSchema,
} from "@/lib/validation";
import { resolveConsoleAgent } from "@/lib/console/resolve-agent";
import { effectiveCrmProvider } from "@/lib/agents/crm-inheritance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Columns we never want to feed back into a schema parse / upsert payload.
const META_KEYS = new Set(["agent_id", "created_at", "updated_at"]);
function stripMeta(row: Record<string, unknown> | null | undefined) {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const [k, v] of Object.entries(row)) {
    if (!META_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const workspaceName = req.nextUrl.searchParams.get("workspace")?.trim();
  const agentName = req.nextUrl.searchParams.get("agent")?.trim() || undefined;
  if (!workspaceName) {
    return NextResponse.json({ error: "missing ?workspace=<name>" }, { status: 400 });
  }

  const db = createServiceClient();
  const resolved = await resolveConsoleAgent(db, workspaceName, agentName);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { agent, workspace } = resolved;

  const [{ data: callConfig }, { data: taskConfig }, { data: stageMap }] =
    await Promise.all([
      db.from("agent_call_configs").select("*").eq("agent_id", agent.id).maybeSingle(),
      db.from("agent_task_configs").select("*").eq("agent_id", agent.id).maybeSingle(),
      db
        .from("agent_pipeline_stage_map")
        .select(
          "outcome, call_attempt, pipeline_id, pipeline_stage_id, pipeline_name, stage_name"
        )
        .eq("agent_id", agent.id),
    ]);

  return NextResponse.json({
    ok: true,
    workspace: workspace.name,
    agent: agent.name,
    effectiveCrmProvider: effectiveCrmProvider(agent, workspace),
    callConfig: stripMeta(callConfig as Record<string, unknown> | null),
    taskConfig: stripMeta(taskConfig as Record<string, unknown> | null),
    pipelineStageMap: stageMap ?? [],
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const workspaceName = String(json.workspace ?? "").trim();
  const agentName =
    typeof json.agent === "string" && json.agent.trim() ? json.agent.trim() : undefined;
  if (!workspaceName) {
    return NextResponse.json({ error: "missing { workspace: <name> }" }, { status: 400 });
  }

  const hasCall = json.callConfig != null;
  const hasTask = json.taskConfig != null;
  const hasMap = json.pipelineStageMap !== undefined;
  if (!hasCall && !hasTask && !hasMap) {
    return NextResponse.json(
      { error: "nothing to update: send callConfig, taskConfig, and/or pipelineStageMap" },
      { status: 400 }
    );
  }

  const db = createServiceClient();
  const resolved = await resolveConsoleAgent(db, workspaceName, agentName);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }
  const { agent, workspace } = resolved;
  const effectiveProvider = effectiveCrmProvider(agent, workspace);
  const applied: string[] = [];
  const warnings: string[] = [];

  // ---- call config (MERGE over existing) ----------------------------------
  if (hasCall) {
    const { data: existing } = await db
      .from("agent_call_configs")
      .select("*")
      .eq("agent_id", agent.id)
      .maybeSingle();
    const merged = { ...stripMeta(existing as Record<string, unknown> | null), ...(json.callConfig as object) };
    const parsed = callConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid callConfig", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const { error } = await db
      .from("agent_call_configs")
      .upsert(
        { agent_id: agent.id, ...parsed.data, updated_at: new Date().toISOString() },
        { onConflict: "agent_id" }
      );
    if (error) {
      return NextResponse.json({ error: `callConfig: ${error.message}` }, { status: 500 });
    }
    applied.push("callConfig");
  }

  // ---- task config / automations (MERGE over existing) --------------------
  if (hasTask) {
    const { data: existing } = await db
      .from("agent_task_configs")
      .select("*")
      .eq("agent_id", agent.id)
      .maybeSingle();
    const merged = { ...stripMeta(existing as Record<string, unknown> | null), ...(json.taskConfig as object) };
    const parsed = taskConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid taskConfig", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    if (
      (parsed.data.pipeline_automation_enabled ||
        parsed.data.poll_stage_enabled ||
        parsed.data.opportunity_custom_field_enabled) &&
      effectiveProvider !== "highlevel"
    ) {
      warnings.push(
        "HighLevel automations are enabled but the effective CRM is not HighLevel — they will no-op."
      );
    }
    const { error } = await db
      .from("agent_task_configs")
      .upsert(
        { agent_id: agent.id, ...parsed.data, updated_at: new Date().toISOString() },
        { onConflict: "agent_id" }
      );
    if (error) {
      return NextResponse.json({ error: `taskConfig: ${error.message}` }, { status: 500 });
    }
    applied.push("taskConfig");
  }

  // ---- pipeline stage map (REPLACE-ALL) -----------------------------------
  if (hasMap) {
    const parsed = pipelineStageMapSchema.safeParse(json.pipelineStageMap);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid pipelineStageMap", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    if (parsed.data.length > 0 && effectiveProvider !== "highlevel") {
      warnings.push(
        "pipelineStageMap set but the effective CRM is not HighLevel — routing will no-op."
      );
    }
    const { error: delErr } = await db
      .from("agent_pipeline_stage_map")
      .delete()
      .eq("agent_id", agent.id);
    if (delErr) {
      return NextResponse.json(
        { error: `pipelineStageMap (clear): ${delErr.message}` },
        { status: 500 }
      );
    }
    if (parsed.data.length > 0) {
      const rows = parsed.data.map((entry) => ({
        agent_id: agent.id,
        outcome: entry.outcome,
        call_attempt: entry.call_attempt,
        pipeline_id: entry.pipeline_id,
        pipeline_stage_id: entry.pipeline_stage_id,
        pipeline_name: entry.pipeline_name,
        stage_name: entry.stage_name,
        updated_at: new Date().toISOString(),
      }));
      const { error: insErr } = await db.from("agent_pipeline_stage_map").insert(rows);
      if (insErr) {
        return NextResponse.json(
          { error: `pipelineStageMap (insert): ${insErr.message}` },
          { status: 500 }
        );
      }
    }
    applied.push(`pipelineStageMap (${parsed.data.length} rule${parsed.data.length === 1 ? "" : "s"})`);
  }

  return NextResponse.json({
    ok: true,
    workspace: workspace.name,
    agent: agent.name,
    effectiveCrmProvider: effectiveProvider,
    applied,
    warnings,
  });
}
