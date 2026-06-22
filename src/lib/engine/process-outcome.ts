// =====================================================================
// Outcome processor — the n8n "Outcome Handler (WF2)" replacement.
//
// Triggered by the Retell `call_analyzed` webhook. For one completed call:
//   1. classify the outcome
//   2. write a formatted note to the CRM
//   3. reconcile tags (strip stale, add current; drop enroll tag if terminal)
//   4. create a follow-up task (if configured)
//   5. update cadence state (attempt, next eligible date, terminal flag)
//   6. update V2 agent memory
// Idempotent on retell_call_id so duplicate webhooks are no-ops.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapter } from "@/lib/crm";
import { classifyOutcome, outcomeLabel, extractFromRetellPayload } from "./outcome";
import { reconcileTags } from "./tags";
import { nextEligibleDate, todayInTz } from "./cadence";
import { updateMemoryAfterCall } from "./memory";
import type {
  Agent, AgentCallConfig, AgentMemory, AgentTaskConfig,
  Contact, OutcomeTag, Workspace,
} from "@/types";

export async function processRetellWebhook(body: any): Promise<{ ok: boolean; reason?: string }> {
  // Retell fires `call_ended` (no analysis) then `call_analyzed` (full).
  const event = body?.event;
  if (event && event !== "call_analyzed") return { ok: true, reason: `ignored event: ${event}` };

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
  const crm = getCrmAdapter(workspace);

  // 2. CRM note (matches the production note format).
  const today = todayInTz(workspace.timezone);
  const note = [
    `AI Agent: ${agent.name}`,
    `Outcome: ${outcomeLabel(outcome)}`,
    `Date: ${today}`,
    "",
    `Summary: ${parsed.summary ?? "(none)"}`,
  ].join("\n");
  try { await crm.addNote(contact.crm_contact_id, note); } catch { /* non-fatal */ }

  // 3. Tags.
  const reconciled = reconcileTags({
    currentTags: contact.tags,
    taxonomy: taxonomy ?? [],
    outcome,
    enrollTag: workspace.enroll_tag,
  });
  try { await crm.setTags(contact.crm_contact_id, reconciled.tags); } catch { /* non-fatal */ }

  // 4. Task.
  let taskCreated = false;
  const { data: taskConfig } = await supabase
    .from("agent_task_configs").select("*").eq("agent_id", agent.id).maybeSingle<AgentTaskConfig>();
  if (taskConfig?.enabled && shouldCreateTask(taskConfig, outcome)) {
    const name = taskConfig.name_template
      .replace("{contact_name}", contact.full_name ?? "Contact")
      .replace("{date}", today);
    const dueAt = new Date(Date.now() + taskConfig.due_offset_minutes * 60_000).toISOString();
    try {
      await crm.createTask({
        contactId: contact.crm_contact_id,
        name,
        type: taskConfig.task_type,
        dueAt,
        assigneeId: taskConfig.assignee_crm_id,
      });
      taskCreated = true;
    } catch { /* non-fatal */ }
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
    })
    .eq("id", call.id);

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
