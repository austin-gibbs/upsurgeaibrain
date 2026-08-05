// =====================================================================
// Inbound processor — productized HighLevel path + legacy FUB delegation.
//
// Triggered by Retell `call_analyzed` when direction === "inbound".
//
// When the agent has an enabled `agent_inbound_configs` row, run the
// config-driven HighLevel automation (tag + opportunity + assign/task).
// Otherwise delegate to the legacy Nil Patel / FUB handler so live
// concierge behavior is unchanged.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { effectiveCrmProvider } from "@/lib/agents/crm-inheritance";
import { sendOpsAlert } from "@/lib/alerts";
import { evaluateAutomations } from "@/lib/engine/automations/evaluate";
import { extractFromRetellPayload } from "./outcome";
import { todayInTz } from "./cadence";
import {
  addTagsToCrm,
  createTasksToCrm,
  formatCrmError,
  logCallToCrm,
  removeTagsFromCrm,
  summarizeCrmErrors,
  type FinalizedBy,
} from "./crm-writeback";
import { buildCustomFieldsFromTaskConfig } from "./pipeline-routing";
import {
  classifyInboundOutcome,
  inboundOutcomeLabel,
  resolveInboundRoute,
} from "./inbound-outcome";
import { pickAssigneeForLine } from "./inbound-routing";
import { parseAssignees } from "./task-eligibility";
import { processInboundCallLegacy } from "./process-inbound-legacy";
import type {
  Agent,
  AgentInboundConfig,
  AgentInboundRoute,
  Workspace,
} from "@/types";
import type { CrmContact } from "@/lib/crm/types";

const CLAIM_LEASE_MS = 5 * 60_000;

export interface ProcessInboundOptions {
  finalizedBy?: FinalizedBy;
}

export async function processInboundCall(
  body: any,
  opts: ProcessInboundOptions = {}
): Promise<{ ok: boolean; reason?: string }> {
  const finalizedBy = opts.finalizedBy ?? "webhook";
  const supabase = createServiceClient();
  const call = body?.call ?? body ?? {};
  const callId = String(call.call_id ?? "");
  if (!callId) return { ok: false, reason: "no call_id in inbound payload" };

  const retellAgentId = String(call.agent_id ?? "");
  if (!retellAgentId) {
    return { ok: false, reason: "no agent_id in inbound payload" };
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("retell_agent_id", retellAgentId)
    .maybeSingle<Agent>();
  if (!agent) {
    return { ok: false, reason: `no agent for retell_agent_id ${retellAgentId}` };
  }

  const { data: inboundConfig } = await supabase
    .from("agent_inbound_configs")
    .select("*")
    .eq("agent_id", agent.id)
    .maybeSingle<AgentInboundConfig>();

  // Feature gate: absent or disabled config → legacy FUB concierge path.
  if (!inboundConfig?.enabled) {
    return processInboundCallLegacy(body);
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", agent.workspace_id)
    .single<Workspace>();
  if (!workspace) return { ok: false, reason: "workspace not found" };

  const provider = effectiveCrmProvider(agent, workspace);
  if (provider !== "highlevel") {
    // Config enabled but CRM isn't HighLevel — fall back rather than fail hard.
    console.warn(
      `[process-inbound] agent ${agent.id} has inbound automation enabled but CRM is ${provider}; using legacy handler`
    );
    return processInboundCallLegacy(body);
  }

  const parsed = extractFromRetellPayload(body);
  const fromNumber: string | null = call.from_number ?? parsed.fromNumber ?? null;
  const toNumber: string | null = call.to_number ?? null;
  const custom: Record<string, unknown> =
    call.call_analysis?.custom_analysis_data ?? parsed.customFields ?? {};

  // 1. Ensure a calls row exists (status=dialing), then atomically claim.
  //    Partial unique index on retell_call_id makes concurrent inserts safe —
  //    the loser re-reads and claims the winner's row.
  const { data: existing } = await supabase
    .from("calls")
    .select("id, status")
    .eq("retell_call_id", callId)
    .maybeSingle<{ id: string; status: string }>();

  let callRowId: string;
  if (existing) {
    if (existing.status === "completed") {
      return { ok: true, reason: "already processed" };
    }
    callRowId = existing.id;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from("calls")
      .insert({
        workspace_id: workspace.id,
        agent_id: agent.id,
        contact_id: null,
        direction: "inbound",
        attempt_number: 0,
        to_number: toNumber ?? fromNumber ?? "",
        retell_call_id: callId,
        status: "dialing",
        summary: parsed.summary,
        transcript: parsed.transcript,
        raw_payload: body,
        dialed_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle<{ id: string }>();

    if (inserted?.id) {
      callRowId = inserted.id;
    } else {
      // Unique-index race: another writer won the insert — re-read.
      const { data: raced } = await supabase
        .from("calls")
        .select("id, status")
        .eq("retell_call_id", callId)
        .maybeSingle<{ id: string; status: string }>();
      if (!raced) {
        return {
          ok: false,
          reason: `failed to insert inbound call: ${insertError?.message ?? "unknown"}`,
        };
      }
      if (raced.status === "completed") {
        return { ok: true, reason: "already processed" };
      }
      callRowId = raced.id;
    }
  }

  return claimAndProcess({
    supabase,
    callRowId,
    agent,
    workspace,
    inboundConfig,
    body,
    parsed,
    custom,
    fromNumber,
    toNumber,
    callId,
    finalizedBy,
  });
}

async function claimAndProcess(args: {
  supabase: ReturnType<typeof createServiceClient>;
  callRowId: string;
  agent: Agent;
  workspace: Workspace;
  inboundConfig: AgentInboundConfig;
  body: any;
  parsed: ReturnType<typeof extractFromRetellPayload>;
  custom: Record<string, unknown>;
  fromNumber: string | null;
  toNumber: string | null;
  callId: string;
  finalizedBy: FinalizedBy;
}): Promise<{ ok: boolean; reason?: string }> {
  const {
    supabase,
    callRowId,
    agent,
    workspace,
    inboundConfig,
    body,
    parsed,
    custom,
    fromNumber,
    toNumber,
    callId,
    finalizedBy,
  } = args;

  const claimThreshold = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const { data: claimed } = await supabase
    .from("calls")
    .update({ outcome_claimed_at: new Date().toISOString() })
    .eq("id", callRowId)
    .neq("status", "completed")
    .or(`outcome_claimed_at.is.null,outcome_claimed_at.lt.${claimThreshold}`)
    .select("id");
  if (!claimed || claimed.length === 0) {
    return { ok: true, reason: "already being processed" };
  }

  const crmErrors: string[] = [];
  const today = todayInTz(workspace.timezone);
  const inboundOutcome = classifyInboundOutcome({ rawOutcome: parsed.rawOutcome });

  // Short-call suppression: persist transcript only.
  if (
    inboundConfig.min_duration_seconds > 0 &&
    parsed.durationSeconds < inboundConfig.min_duration_seconds
  ) {
    await supabase
      .from("calls")
      .update({
        status: "completed",
        inbound_outcome: inboundOutcome,
        summary: parsed.summary,
        transcript: parsed.transcript,
        raw_payload: body,
        completed_at: new Date().toISOString(),
        finalized_by: finalizedBy,
        crm_error: `suppressed: duration ${parsed.durationSeconds}s < min ${inboundConfig.min_duration_seconds}s`,
      })
      .eq("id", callRowId);
    return { ok: true, reason: "short call suppressed" };
  }

  const { data: routes } = await supabase
    .from("agent_inbound_routes")
    .select("*")
    .eq("agent_id", agent.id)
    .returns<AgentInboundRoute[]>();

  const resolved = resolveInboundRoute(routes ?? [], inboundOutcome, inboundConfig);
  const crm = getCrmAdapterForAgent(agent, workspace);

  if (!crm.findContactByPhone || !crm.createContact) {
    await finalizeInboundCall(supabase, callRowId, {
      status: "completed",
      inbound_outcome: inboundOutcome,
      inbound_route_id: resolved.route?.id ?? null,
      summary: parsed.summary,
      transcript: parsed.transcript,
      raw_payload: body,
      finalized_by: finalizedBy,
      crm_error: "CRM adapter lacks inbound contact resolution",
    });
    await alertInboundCrmError(agent, callId, "CRM adapter lacks inbound contact resolution");
    return { ok: false, reason: "CRM adapter lacks inbound contact resolution" };
  }

  const callerName = str(custom.caller_full_name) || str(custom.caller_name) || null;
  const callerEmail = str(custom.caller_email) || null;
  const callbackPhone = str(custom.caller_phone) || fromNumber;

  // 2. Resolve or create contact.
  let contact: CrmContact | null = null;
  try {
    contact = fromNumber ? await crm.findContactByPhone(fromNumber) : null;
  } catch (e) {
    crmErrors.push(`findContactByPhone: ${formatCrmError(e)}`);
  }

  if (!contact) {
    if (!inboundConfig.create_contact_if_missing) {
      const err = "no matching contact and create_contact_if_missing=false";
      await finalizeInboundCall(supabase, callRowId, {
        status: "completed",
        inbound_outcome: inboundOutcome,
        inbound_route_id: resolved.route?.id ?? null,
        summary: parsed.summary,
        transcript: parsed.transcript,
        raw_payload: body,
        finalized_by: finalizedBy,
        crm_error: summarizeCrmErrors([...crmErrors, err]),
      });
      await alertInboundCrmError(agent, callId, err);
      return { ok: true, reason: err };
    }
    try {
      const seedTags = [
        inboundConfig.always_tag,
        "AI Inbound Call",
      ].filter((t): t is string => Boolean(t?.trim()));
      contact = await crm.createContact({
        fullName: callerName,
        phone: callbackPhone,
        email: callerEmail,
        tags: seedTags,
        source: inboundConfig.new_contact_source || "AI Inbound Call",
      });
    } catch (e) {
      const err = `createContact: ${formatCrmError(e)}`;
      await finalizeInboundCall(supabase, callRowId, {
        status: "completed",
        inbound_outcome: inboundOutcome,
        inbound_route_id: resolved.route?.id ?? null,
        summary: parsed.summary,
        transcript: parsed.transcript,
        raw_payload: body,
        finalized_by: finalizedBy,
        crm_error: summarizeCrmErrors([...crmErrors, err]),
      });
      await alertInboundCrmError(agent, callId, err);
      return { ok: false, reason: err };
    }
  }

  // 3. Log call (incoming) with note.
  const note = [
    `AI Inbound Agent: ${agent.name}`,
    `Outcome: ${inboundOutcomeLabel(inboundOutcome)}`,
    `Date: ${today}`,
    "",
    `Summary: ${parsed.summary ?? "(none)"}`,
  ].join("\n");

  const crmFlags = await logCallToCrm({
    crm,
    contactId: contact.id,
    phone: callbackPhone ?? fromNumber ?? "",
    note,
    recordingUrl: parsed.recordingUrl,
    durationSeconds: parsed.durationSeconds || undefined,
    fromNumber,
    toNumber: toNumber ?? "",
    outcome: inboundOutcome,
    isIncoming: true,
  });
  crmErrors.push(...crmFlags.crmErrors);

  // 4. Tags — baseline always_tag + outcome tag; then remove stale tags.
  const tagsToAdd = [
    inboundConfig.always_tag,
    resolved.tag,
  ].filter((t): t is string => Boolean(t?.trim()));
  let appliedTag: string | null = resolved.tag ?? inboundConfig.always_tag ?? null;
  try {
    await addTagsToCrm(crm, contact.id, tagsToAdd, contact.tags ?? []);
    crmFlags.tagsSynced = true;
  } catch (e) {
    crmErrors.push(`addTags: ${formatCrmError(e)}`);
  }
  if (resolved.removeTags.length) {
    try {
      await removeTagsFromCrm(crm, contact.id, resolved.removeTags, contact.tags ?? []);
    } catch (e) {
      crmErrors.push(`removeTags: ${formatCrmError(e)}`);
    }
  }

  // 5. Opportunity create/update via moveContactToStage.
  let opportunityId: string | null = null;
  if (
    inboundConfig.pipeline_automation_enabled &&
    crm.moveContactToStage &&
    resolved.pipelineId &&
    resolved.stageId
  ) {
    try {
      const contactName =
        contact.fullName ||
        callerName ||
        inboundConfig.opportunity_name_template.replace(
          "{contact_name}",
          callerName || "Inbound Lead"
        );
      const nameFromTemplate = inboundConfig.opportunity_name_template
        .replace("{contact_name}", contact.fullName || callerName || "Inbound Lead")
        .replace("{outcome}", inboundOutcomeLabel(inboundOutcome))
        .replace("{date}", today);
      const customFields = buildCustomFieldsFromTaskConfig({
        opportunity_custom_field_enabled: inboundConfig.opportunity_custom_field_enabled,
        opportunity_custom_field_id: inboundConfig.opportunity_custom_field_id,
        opportunity_custom_field_key: inboundConfig.opportunity_custom_field_key,
        opportunity_custom_field_value: inboundConfig.opportunity_custom_field_value,
      });
      const result = await crm.moveContactToStage({
        contactId: contact.id,
        pipelineId: resolved.pipelineId,
        stageId: resolved.stageId,
        contactName: nameFromTemplate || contactName,
        status: resolved.opportunityStatus ?? undefined,
        customFields,
      });
      if (typeof result === "string") opportunityId = result;
    } catch (e) {
      crmErrors.push(`moveContactToStage: ${formatCrmError(e)}`);
    }
  }

  // 6. Assign + tasks.
  let taskCreated = false;
  const assigneeIds = await resolveInboundAssignees({
    mode: inboundConfig.assignee_mode,
    fixedAssigneeCrmId: inboundConfig.assignee_crm_id,
    toNumber,
    crm,
  });

  if (assigneeIds.length && crm.assignContact) {
    try {
      await crm.assignContact(contact.id, assigneeIds[0]);
    } catch (e) {
      crmErrors.push(`assignContact: ${formatCrmError(e)}`);
    }
  }

  if (inboundConfig.task_enabled) {
    const leadName = contact.fullName || callerName || "Inbound Caller";
    const taskName = inboundConfig.task_name_template
      .replace("{contact_name}", leadName)
      .replace("{outcome}", inboundOutcomeLabel(inboundOutcome))
      .replace("{date}", today);
    const dueAt = new Date(
      Date.now() + inboundConfig.task_due_offset_minutes * 60_000
    ).toISOString();
    const targets = assigneeIds.length ? assigneeIds : [null];
    taskCreated = await createTasksToCrm(
      crm,
      contact.id,
      targets.map((assigneeId) => ({
        name: taskName,
        type: inboundConfig.task_type || "Follow Up",
        dueAt,
        assigneeId,
      })),
      crmFlags
    );
    crmErrors.push(...crmFlags.crmErrors.filter((e) => e.startsWith("createTask")));
  }

  // 7. Config-driven post-call automations (best-effort).
  // Outcome is cast — inbound taxonomy is text; automations match on
  // custom_analysis_data conditions more often than the enum outcome.
  try {
    await evaluateAutomations({
      supabase,
      workspace,
      agent,
      contact: {
        id: "",
        workspace_id: workspace.id,
        crm_contact_id: contact.id,
        full_name: contact.fullName,
        email: contact.email,
        phones: contact.phones,
        tags: contact.tags,
        attempt_count: 0,
        last_called_on: null,
        next_eligible_on: null,
        is_terminal: false,
        terminal_outcome: null,
      },
      callId: callRowId,
      retellCallId: callId,
      contactPhone: callbackPhone ?? fromNumber ?? "",
      outcome: inboundOutcome as any,
      summary: parsed.summary,
      transcript: parsed.transcript,
      recordingUrl: parsed.recordingUrl,
      customFields: parsed.customFields,
    });
  } catch {
    /* non-fatal */
  }

  const crmError = summarizeCrmErrors(crmErrors);
  await finalizeInboundCall(supabase, callRowId, {
    status: "completed",
    inbound_outcome: inboundOutcome,
    inbound_route_id: resolved.route?.id ?? null,
    opportunity_id: opportunityId,
    summary: parsed.summary,
    transcript: parsed.transcript,
    raw_payload: body,
    completed_at: new Date().toISOString(),
    crm_contact_id: contact.id,
    contact_name: contact.fullName ?? callerName,
    contact_email: contact.email ?? callerEmail,
    applied_tag: appliedTag,
    task_created: taskCreated,
    note_logged: crmFlags.noteLogged,
    recording_logged: crmFlags.recordingLogged,
    tags_synced: crmFlags.tagsSynced,
    finalized_by: finalizedBy,
    crm_error: crmError,
  });

  if (crmError) {
    await alertInboundCrmError(agent, callId, crmError);
  }

  return { ok: true };
}

async function finalizeInboundCall(
  supabase: ReturnType<typeof createServiceClient>,
  callRowId: string,
  patch: Record<string, unknown>
): Promise<void> {
  await supabase
    .from("calls")
    .update({
      completed_at: new Date().toISOString(),
      ...patch,
    })
    .eq("id", callRowId);
}

async function alertInboundCrmError(
  agent: Agent,
  retellCallId: string,
  detail: string
): Promise<void> {
  try {
    await sendOpsAlert(
      `[inbound] CRM writeback error for agent "${agent.name}" (${agent.id}) ` +
        `retell_call_id=${retellCallId}: ${detail}`
    );
  } catch {
    /* never throw from alert */
  }
}

async function resolveInboundAssignees(args: {
  mode: AgentInboundConfig["assignee_mode"];
  fixedAssigneeCrmId: string | null;
  toNumber: string | null;
  crm: ReturnType<typeof getCrmAdapterForAgent>;
}): Promise<string[]> {
  const { mode, fixedAssigneeCrmId, toNumber, crm } = args;
  if (mode === "none") return [];
  if (mode === "fixed") return parseAssignees(fixedAssigneeCrmId);
  if (mode === "dialed_line") {
    try {
      const users = await crm.listUsers();
      const line = pickAssigneeForLine(toNumber, users);
      if (line) return [line.id];
      // Fall back to fixed list when the dialed line isn't mapped.
      return parseAssignees(fixedAssigneeCrmId);
    } catch {
      return parseAssignees(fixedAssigneeCrmId);
    }
  }
  return parseAssignees(fixedAssigneeCrmId);
}

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
