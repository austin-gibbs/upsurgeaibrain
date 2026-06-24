// =====================================================================
// Pipeline routing — app-driven HighLevel opportunity stage moves.
//
// After a call is classified, look up the per-agent outcome (+ optional
// call-attempt) -> pipeline stage mapping and move the contact's
// opportunity there. Exact attempt match wins; NULL call_attempt is the
// outcome-only fallback. No-op for CRMs without pipelines (FUB).
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CrmAdapter } from "@/lib/crm";
import type { CallOutcome, Contact } from "@/types";

interface ApplyPipelineRoutingArgs {
  supabase: SupabaseClient;
  crm: CrmAdapter;
  agentId: string;
  contact: Contact;
  outcome: CallOutcome;
  attemptNumber: number;
}

type StageMapRow = {
  pipeline_id: string;
  pipeline_stage_id: string;
  call_attempt: number | null;
};

/**
 * Move the contact's opportunity to the stage mapped for this outcome
 * (and optionally call attempt). Best-effort by contract.
 */
export async function applyPipelineRouting(
  args: ApplyPipelineRoutingArgs
): Promise<{ moved: boolean; reason?: string }> {
  const { supabase, crm, agentId, contact, outcome, attemptNumber } = args;

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

  await crm.moveContactToStage({
    contactId: contact.crm_contact_id,
    pipelineId: mapping.pipeline_id,
    stageId: mapping.pipeline_stage_id,
    contactName: contact.full_name,
  });

  return { moved: true };
}
