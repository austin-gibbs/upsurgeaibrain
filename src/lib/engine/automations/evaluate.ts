// =====================================================================
// Automation evaluation — the hook called from process-outcome after the
// existing CRM/cadence side effects. For one analyzed call it:
//   1. loads every enabled trigger for the call's workspace (+ this agent)
//   2. builds a context snapshot from the Retell custom_analysis_data
//   3. matches each trigger (pure, see conditions.ts)
//   4. dedupes against recent sent runs (per trigger + contact phone)
//   5. resolves the link (link_type -> automation_links.url)
//   6. inserts an automation_runs row (queued) with the fully-rendered request
//   7. enqueues an executor job (the worker fires the webhook)
//
// Additive and best-effort: never throws into the outcome pipeline. If Redis
// is down the run row is still persisted (queued) and the minute-tick /
// failover drain will pick it up.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { enqueueAutomation } from "@/lib/queue/queues";
import { buildRequest, firstNameOf, resolveLinkType } from "./build-request";
import { triggerMatches } from "./conditions";
import type {
  AutomationActionConfig,
  AutomationCondition,
  AutomationEvalContext,
  AutomationLink,
  AutomationTrigger,
  MatchType,
} from "./types";
import type { Agent, CallOutcome, Contact, Workspace } from "@/types";
import type { Json } from "@/types/database";

type DbClient = ReturnType<typeof createServiceClient>;

/** True when an equivalent run was already sent inside the dedupe window. */
async function isDuplicate(
  supabase: DbClient,
  triggerId: string,
  contactPhone: string,
  windowHours: number
): Promise<boolean> {
  if (windowHours <= 0) return false;
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const { data } = await supabase
    .from("automation_runs")
    .select("id")
    .eq("trigger_id", triggerId)
    .eq("contact_phone", contactPhone)
    .in("status", ["sent", "queued"])
    .gte("created_at", since)
    .limit(1);
  return Boolean(data && data.length > 0);
}

export interface EvaluateAutomationsInput {
  supabase: DbClient;
  workspace: Workspace;
  agent: Agent;
  contact: Contact;
  callId: string;
  retellCallId: string | null;
  contactPhone: string;
  outcome: CallOutcome;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  customFields: Record<string, unknown>;
}

export async function evaluateAutomations(input: EvaluateAutomationsInput): Promise<{
  matched: number;
  enqueued: number;
}> {
  const { supabase } = input;

  // Enabled triggers for this workspace that apply to this agent (agent_id NULL
  // = all agents) — one query, filtered in memory for the agent scope.
  const { data: rows, error } = await supabase
    .from("automation_triggers")
    .select("*")
    .eq("workspace_id", input.workspace.id)
    .eq("enabled", true);
  if (error || !rows || rows.length === 0) return { matched: 0, enqueued: 0 };

  const triggers: AutomationTrigger[] = rows
    .filter((r) => r.agent_id === null || r.agent_id === input.agent.id)
    .map((r) => ({
      ...r,
      conditions: (r.conditions ?? []) as unknown as AutomationCondition[],
      action_config: (r.action_config ?? {}) as unknown as AutomationActionConfig,
      match_type: (r.match_type as MatchType) ?? "all",
    })) as AutomationTrigger[];
  if (triggers.length === 0) return { matched: 0, enqueued: 0 };

  const ctx: AutomationEvalContext = {
    outcome: input.outcome,
    summary: input.summary,
    transcript: input.transcript,
    recordingUrl: input.recordingUrl,
    customFields: input.customFields ?? {},
    contact: {
      first_name: firstNameOf(input.contact.full_name),
      full_name: input.contact.full_name,
      email: input.contact.email,
      phone: input.contactPhone,
    },
  };

  // Lazy-load the workspace link map only if a matched trigger needs it.
  let linkMap: Map<string, AutomationLink> | null = null;
  const loadLinks = async (): Promise<Map<string, AutomationLink>> => {
    if (linkMap) return linkMap;
    const { data } = await supabase
      .from("automation_links")
      .select("*")
      .eq("workspace_id", input.workspace.id);
    linkMap = new Map((data ?? []).map((l) => [l.link_type, l as AutomationLink]));
    return linkMap;
  };

  let matched = 0;
  let enqueued = 0;

  for (const trigger of triggers) {
    if (!triggerMatches(trigger, ctx)) continue;
    matched++;

    if (await isDuplicate(supabase, trigger.id, input.contactPhone, trigger.dedupe_window_hours)) {
      await supabase.from("automation_runs").insert({
        workspace_id: input.workspace.id,
        trigger_id: trigger.id,
        agent_id: input.agent.id,
        call_id: input.callId,
        retell_call_id: input.retellCallId,
        contact_id: input.contact.id,
        contact_phone: input.contactPhone,
        status: "skipped",
        action_type: trigger.action_type,
        last_error: "deduped: recent run within dedupe window",
      });
      continue;
    }

    const linkType = resolveLinkType(trigger.action_config, ctx);
    let link = { type: linkType, url: null as string | null, label: null as string | null };
    if (linkType) {
      const map = await loadLinks();
      const found = map.get(linkType);
      if (found) link = { type: linkType, url: found.url, label: found.label };
    }

    const { url, payload } = buildRequest(trigger, ctx, link);

    const { data: run, error: insErr } = await supabase
      .from("automation_runs")
      .insert({
        workspace_id: input.workspace.id,
        trigger_id: trigger.id,
        agent_id: input.agent.id,
        call_id: input.callId,
        retell_call_id: input.retellCallId,
        contact_id: input.contact.id,
        contact_phone: input.contactPhone,
        status: "queued",
        attempts: 0,
        max_attempts: trigger.max_attempts,
        action_type: trigger.action_type,
        request_url: url,
        request_payload: payload as unknown as Json,
        meta: {
          link_type: link.type,
          link_url: link.url,
          trigger_name: trigger.name,
          headers: trigger.action_config.headers ?? undefined,
        } as unknown as Json,
      })
      .select("id")
      .single();
    if (insErr || !run) continue;

    // Best-effort kick — if Redis is down the row stays queued and the
    // minute-tick sweeper picks it up.
    try {
      await enqueueAutomation({ runId: run.id });
      enqueued++;
    } catch (err) {
      // The queued row is durable and the drain sweep retries it, but a
      // persistent enqueue fault stalls every automation silently — log it.
      console.warn(
        `[automations] enqueue failed for run ${run.id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return { matched, enqueued };
}
