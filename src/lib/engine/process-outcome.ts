// =====================================================================
// Outcome processor — the n8n "Outcome Handler (WF2)" replacement.
//
// Triggered by the Retell `call_analyzed` webhook. For one completed call:
//   1. classify the outcome
//   2. log the call to the CRM (recording + call notes)
//   3. reconcile tags (strip stale, add current; drop enroll tag if terminal)
//   4. create a follow-up task (if configured)
//   5. update cadence state (attempt, next eligible date, terminal flag)
//   6. update V2 agent memory
// Idempotent on retell_call_id so duplicate webhooks are no-ops.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { classifyOutcome, outcomeLabel, extractFromRetellPayload } from "./outcome";
import { reconcileTags } from "./tags";
import { nextEligibleDate, todayInTz } from "./cadence";
import { updateMemoryAfterCall } from "./memory";
import { applyPipelineRouting } from "./pipeline-routing";
import { processInboundCall } from "./process-inbound";
import { dispatchPostCallWebhook } from "@/lib/webhooks/post-call";
import {
  createTasksToCrm,
  logCallToCrm,
  summarizeCrmErrors,
  syncTagsToCrm,
  type FinalizedBy,
} from "./crm-writeback";
import { completeQueueEntry } from "./call-queue";
import type {
  Agent, AgentCallConfig, AgentMemory, AgentTaskConfig,
  Contact, OutcomeTag, Workspace,
} from "@/types";

export interface ProcessRetellWebhookOptions {
  /** Whether this run came from the live webhook or the stuck-call reconciler. */
  finalizedBy?: FinalizedBy;
}

// How long a processing claim is held before another run may re-claim a call
// whose previous processor apparently died mid-flight. Long enough to cover the
// slowest CRM writeback, short enough that a real crash recovers quickly.
const CLAIM_LEASE_MS = 5 * 60_000;

export async function processRetellWebhook(
  body: any,
  opts: ProcessRetellWebhookOptions = {}
): Promise<{ ok: boolean; reason?: string }> {
  const finalizedBy = opts.finalizedBy ?? "webhook";
  // Retell fires `call_ended` (no analysis) then `call_analyzed` (full).
  const event = body?.event;
  if (event && event !== "call_analyzed") return { ok: true, reason: `ignored event: ${event}` };

  // Inbound concierge calls (answered on the business line) have no
  // pre-created call row — hand them to the dedicated inbound processor.
  if ((body?.call ?? body)?.direction === "inbound") {
    return processInboundCall(body);
  }

  const supabase = createServiceClient();
  const parsed = extractFromRetellPayload(body);
  if (!parsed.callId) return { ok: false, reason: "no call_id in payload" };

  // Correlate to our call row via metadata.call_id (preferred) or retell id.
  const ourCallId = parsed.metadata.call_id;
  const { data: call } = await supabase
    .from("calls")
    .select("*")
    .or(`id.eq.${ourCallId ?? "00000000-0000-0000-0000-000000000000"},retell_call_id.eq.${parsed.callId}`)
    .maybeSingle<any>();
  if (!call) return { ok: false, reason: "no matching call row" };
  if (call.status === "completed") return { ok: true, reason: "already processed" };

  // Atomically CLAIM this call before doing any side effects. Retell re-sends
  // `call_analyzed`, and the stuck-call reconciler is a second caller — without
  // this, two concurrent runs both pass the check above and double-write to the
  // client's CRM (duplicate note/tag/task, cadence advanced twice). The claim is
  // a time-leased compare-and-set: succeed only if unclaimed or the prior claim
  // is older than the lease (so a crash mid-processing self-heals on retry).
  const claimThreshold = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const { data: claimed } = await supabase
    .from("calls")
    .update({ outcome_claimed_at: new Date().toISOString() })
    .eq("id", call.id)
    .neq("status", "completed")
    .or(`outcome_claimed_at.is.null,outcome_claimed_at.lt.${claimThreshold}`)
    .select("id");
  if (!claimed || claimed.length === 0) {
    return { ok: true, reason: "already being processed" };
  }

  // Contact-less outbound rows are manual test calls (placed via placeTestCall).
  // Persist the outcome/transcript for visibility but skip all CRM, cadence, and
  // memory side effects — there is no contact to advance.
  if (!call.contact_id) {
    const outcome = classifyOutcome({
      rawOutcome: parsed.rawOutcome,
      inVoicemail: parsed.inVoicemail,
    });
    await supabase
      .from("calls")
      .update({
        status: "completed",
        outcome,
        in_voicemail: parsed.inVoicemail,
        summary: parsed.summary,
        transcript: parsed.transcript,
        raw_payload: body,
        completed_at: new Date().toISOString(),
      })
      .eq("id", call.id);
    return { ok: true, reason: "test call (no contact)" };
  }

  const [{ data: agent }, { data: workspace }, { data: contact }] = await Promise.all([
    supabase.from("agents").select("*").eq("id", call.agent_id).single<Agent>(),
    supabase.from("workspaces").select("*").eq("id", call.workspace_id).single<Workspace>(),
    supabase.from("contacts").select("*").eq("id", call.contact_id).single<Contact>(),
  ]);
  if (!agent || !workspace || !contact) return { ok: false, reason: "missing related rows" };

  const { data: taxonomy } = await supabase
    .from("workspace_outcome_tags").select("*").eq("workspace_id", workspace.id)
    .returns<OutcomeTag[]>();

  const outcome = classifyOutcome({ rawOutcome: parsed.rawOutcome, inVoicemail: parsed.inVoicemail });
  const crm = getCrmAdapterForAgent(agent, workspace);
  // The agent can be connected to a CRM directly (e.g. HighLevel via OAuth)
  // even when the workspace defaults to a different provider. Gate
  // provider-specific side effects on this *effective* provider so an
  // agent-level HighLevel connection still drives opportunity/webhook logic.
  const effectiveProvider = agent.crm_provider ?? workspace.crm_provider;

  // 2. CRM call log (recording play button + call notes in FUB).
  const today = todayInTz(workspace.timezone);
  const note = [
    `AI Agent: ${agent.name}`,
    `Outcome: ${outcomeLabel(outcome)}`,
    `Date: ${today}`,
    "",
    `Summary: ${parsed.summary ?? "(none)"}`,
  ].join("\n");

  const crmFlags = await logCallToCrm({
    crm,
    contactId: contact.crm_contact_id,
    phone: call.to_number,
    note,
    recordingUrl: parsed.recordingUrl,
    durationSeconds: parsed.durationSeconds || undefined,
    fromNumber: parsed.fromNumber,
    toNumber: call.to_number,
  });

  // 3. Tags.
  const reconciled = reconcileTags({
    currentTags: contact.tags,
    taxonomy: taxonomy ?? [],
    outcome,
    enrollTag: agent.enroll_tag ?? workspace.enroll_tag,
  });
  await syncTagsToCrm(crm, contact.crm_contact_id, reconciled.tags, crmFlags);

  // Parity guard: on a TERMINAL outcome we always stop calling locally (below),
  // which is the safe direction — it prevents re-dialing someone who asked for
  // DND / declined even if the CRM write failed. But if the tag sync failed, the
  // enroll tag was NOT removed in the CRM, so the CRM and our state have
  // diverged. Make that loud and durable so an operator can reconcile the CRM
  // rather than it failing silently. (crm_error is also persisted on the row.)
  if (reconciled.isTerminal && !crmFlags.tagsSynced) {
    console.error(
      `[process-outcome] TERMINAL outcome ${outcome} for contact ${contact.id} ` +
        `(crm ${contact.crm_contact_id}) but tag sync FAILED — enroll tag may remain in CRM; manual reconcile needed.`
    );
  }

  // 4. Task(s). assignee_crm_id may hold several comma-separated CRM user
  // ids ("1,17"); in that case we create one task per assignee so each team
  // member gets their own copy.
  let taskCreated = false;
  const { data: taskConfig } = await supabase
    .from("agent_task_configs").select("*").eq("agent_id", agent.id).maybeSingle<AgentTaskConfig>();
  if (taskConfig?.enabled && shouldCreateTask(taskConfig, outcome)) {
    const name = taskConfig.name_template
      .replace("{contact_name}", contact.full_name ?? "Contact")
      .replace("{date}", today);
    const dueAt = new Date(Date.now() + taskConfig.due_offset_minutes * 60_000).toISOString();
    const assignees = parseAssignees(taskConfig.assignee_crm_id);
    const targets = assignees.length ? assignees : [null];
    taskCreated = await createTasksToCrm(
      crm,
      contact.crm_contact_id,
      targets.map((assigneeId) => ({
        name,
        type: taskConfig.task_type,
        dueAt,
        assigneeId,
      })),
      crmFlags
    );
  }

  // 4b. HighLevel post-call workflow webhook (best-effort).
  if (
    effectiveProvider === "highlevel" &&
    taskConfig?.post_call_webhook_enabled &&
    taskConfig.post_call_webhook_url &&
    shouldDispatchWebhook(taskConfig, outcome)
  ) {
    try {
      await dispatchPostCallWebhook({
        webhookUrl: taskConfig.post_call_webhook_url,
        workspace,
        agent,
        contact,
        call,
        outcome,
        parsed,
        appliedTag: reconciled.appliedTag,
        callDate: today,
      });
    } catch { /* non-fatal */ }
  }

  // 4c. HighLevel pipeline routing (best-effort, app-driven). Move the
  // contact's opportunity to the stage mapped for this outcome — no
  // hand-built HighLevel workflow required. No-op when disabled, when the
  // CRM has no pipelines (FUB), or when the outcome has no mapped stage.
  if (effectiveProvider === "highlevel" && taskConfig?.pipeline_automation_enabled) {
    try {
      await applyPipelineRouting({
        supabase,
        crm,
        agentId: agent.id,
        contact,
        outcome,
        attemptNumber: call.attempt_number,
      });
    } catch {
      /* non-fatal: never block cadence advance on a pipeline move */
    }
  }

  // 5. Cadence state.
  const { data: config } = await supabase
    .from("agent_call_configs").select("*").eq("agent_id", agent.id).single<AgentCallConfig>();
  const nextEligible = config ? nextEligibleDate(call.attempt_number, config, today) : null;
  await supabase
    .from("contacts")
    .update({
      tags: reconciled.tags,
      is_terminal: reconciled.isTerminal,
      terminal_outcome: reconciled.isTerminal ? outcome : null,
      next_eligible_on: reconciled.isTerminal ? null : nextEligible,
    })
    .eq("id", contact.id);

  // Persist call record.
  await supabase
    .from("calls")
    .update({
      status: "completed",
      outcome,
      in_voicemail: parsed.inVoicemail,
      summary: parsed.summary,
      transcript: parsed.transcript,
      raw_payload: body,
      applied_tag: reconciled.appliedTag,
      task_created: taskCreated,
      completed_at: new Date().toISOString(),
      crm_contact_id: contact.crm_contact_id,
      contact_name: contact.full_name,
      contact_email: contact.email,
      finalized_by: finalizedBy,
      note_logged: crmFlags.noteLogged,
      recording_logged: crmFlags.recordingLogged,
      tags_synced: crmFlags.tagsSynced,
      crm_error: summarizeCrmErrors(crmFlags.crmErrors),
    })
    .eq("id", call.id);

  await completeQueueEntry(supabase, { callId: call.id });

  // 6. V2 memory.
  const { data: priorMemory } = await supabase
    .from("agent_memory").select("*")
    .eq("agent_id", agent.id).eq("contact_id", contact.id).maybeSingle<AgentMemory>();
  await updateMemoryAfterCall(supabase, {
    workspaceId: workspace.id,
    agentId: agent.id,
    contactId: contact.id,
    callId: call.id,
    agentObjective: agent.objective,
    priorMemory: priorMemory ?? null,
    transcript: parsed.transcript,
    summary: parsed.summary,
    outcome,
  });

  return { ok: true };
}

function shouldCreateTask(cfg: AgentTaskConfig, outcome: string): boolean {
  if (!cfg.only_outcomes || cfg.only_outcomes.length === 0) return true;
  return cfg.only_outcomes.includes(outcome as any);
}

function shouldDispatchWebhook(cfg: AgentTaskConfig, outcome: string): boolean {
  if (!cfg.post_call_webhook_only_outcomes || cfg.post_call_webhook_only_outcomes.length === 0) {
    return true;
  }
  return cfg.post_call_webhook_only_outcomes.includes(outcome as any);
}

// assignee_crm_id may hold a single CRM user id ("17") or several
// comma/space-separated ids ("1,17"). Split so each listed user gets a task.
function parseAssignees(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}
