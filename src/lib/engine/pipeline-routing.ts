// =====================================================================
// Pipeline routing — app-driven HighLevel opportunity stage moves.
//
// After a call is classified, look up the per-agent outcome (+ optional
// call-attempt) -> pipeline stage mapping and move the contact's
// opportunity there. Exact attempt match wins; NULL call_attempt is the
// outcome-only fallback. No-op for CRMs without pipelines (FUB).
//
// Also supports poll-time stage moves and applying a configured
// opportunity custom-field dropdown on every create/update.
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmAdapter } from "@/lib/crm";
import type { OpportunityCustomFieldInput } from "@/lib/crm/types";
import type { AgentTaskConfig, CallOutcome, Contact } from "@/types";

interface ApplyPipelineRoutingArgs {
  supabase: SupabaseClient;
  crm: CrmAdapter;
  agentId: string;
  contact: Contact;
  outcome: CallOutcome;
  attemptNumber: number;
  taskConfig?: AgentTaskConfig | null;
}

type StageMapRow = {
  pipeline_id: string;
  pipeline_stage_id: string;
  call_attempt: number | null;
};

type TaskConfigCustomFieldSlice = Pick<
  AgentTaskConfig,
  | "opportunity_custom_field_enabled"
  | "opportunity_custom_field_id"
  | "opportunity_custom_field_key"
  | "opportunity_custom_field_value"
>;

/** Build the customFields payload from agent task config, if enabled. */
export function buildCustomFieldsFromTaskConfig(
  taskConfig: TaskConfigCustomFieldSlice | null | undefined
): OpportunityCustomFieldInput[] | undefined {
  if (
    !taskConfig?.opportunity_custom_field_enabled ||
    !taskConfig.opportunity_custom_field_id?.trim() ||
    !taskConfig.opportunity_custom_field_value?.trim()
  ) {
    return undefined;
  }
  return [
    {
      id: taskConfig.opportunity_custom_field_id,
      ...(taskConfig.opportunity_custom_field_key
        ? { key: taskConfig.opportunity_custom_field_key }
        : {}),
      field_value: taskConfig.opportunity_custom_field_value,
    },
  ];
}

/**
 * Move the contact's opportunity to the stage mapped for this outcome
 * (and optionally call attempt). Best-effort by contract.
 */
export async function applyPipelineRouting(
  args: ApplyPipelineRoutingArgs
): Promise<{ moved: boolean; reason?: string }> {
  const { supabase, crm, agentId, contact, outcome, attemptNumber, taskConfig } = args;

  if (!crm.moveContactToStage) return { moved: false, reason: "crm has no pipelines" };

  const { data: rows } = await supabase
    .from("agent_pipeline_stage_map")
    .select("pipeline_id, pipeline_stage_id, call_attempt")
    .eq("agent_id", agentId)
    .eq("outcome", outcome)
    .returns<StageMapRow[]>();

  const mappings = rows ?? [];
  const exact = mappings.find((m) => m.call_attempt === attemptNumber);
  const fallback = mappings.find((m) => m.call_attempt == null);
  const mapping = exact ?? fallback;

  if (!mapping?.pipeline_id || !mapping?.pipeline_stage_id) {
    return { moved: false, reason: "no stage mapped for outcome" };
  }

  const customFields = buildCustomFieldsFromTaskConfig(taskConfig);

  await crm.moveContactToStage({
    contactId: contact.crm_contact_id,
    pipelineId: mapping.pipeline_id,
    stageId: mapping.pipeline_stage_id,
    contactName: contact.full_name,
    customFields,
  });

  return { moved: true };
}

/**
 * During poll, move eligible queued contacts' opportunities to the configured
 * poll stage. Best-effort — failures are logged but do not abort the poll.
 */
export async function applyPollStageRouting(args: {
  crm: CrmAdapter;
  contacts: Contact[];
  taskConfig: AgentTaskConfig | null;
}): Promise<void> {
  const { crm, contacts, taskConfig } = args;
  if (!crm.moveContactToStage) return;
  if (!taskConfig?.poll_stage_enabled) return;
  if (!taskConfig.poll_pipeline_id?.trim() || !taskConfig.poll_pipeline_stage_id?.trim()) {
    return;
  }

  const customFields = buildCustomFieldsFromTaskConfig(taskConfig);

  for (const contact of contacts) {
    if (!contact.crm_contact_id) continue;
    try {
      await crm.moveContactToStage({
        contactId: contact.crm_contact_id,
        pipelineId: taskConfig.poll_pipeline_id,
        stageId: taskConfig.poll_pipeline_stage_id,
        contactName: contact.full_name,
        customFields,
      });
    } catch (e) {
      console.error(
        `[poll] failed to move contact ${contact.crm_contact_id} to poll stage:`,
        e instanceof Error ? e.message : e
      );
    }
  }
}
