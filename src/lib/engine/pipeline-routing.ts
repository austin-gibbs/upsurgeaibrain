// =====================================================================
// Pipeline routing — app-driven HighLevel opportunity stage moves.
//
// After a call is classified, look up the per-agent outcome -> pipeline
// stage mapping and move the contact's opportunity there. This replaces
// hand-built HighLevel workflows: the routing rules live as data in
// `agent_pipeline_stage_map`, and the engine drives the move via the CRM
// adapter's Opportunities API. No-op for CRMs without pipelines (FUB).
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
}

/**
 * Move the contact's opportunity to the stage mapped for this outcome.
 * Best-effort by contract: callers should still wrap in try/catch, but this
 * returns quietly when the CRM has no pipeline support or no mapping exists.
 */
export async function applyPipelineRouting(
  args: ApplyPipelineRoutingArgs
): Promise<{ moved: boolean; reason?: string }> {
  const { supabase, crm, agentId, contact, outcome } = args;

  // CRM doesn't support pipelines (e.g. Follow Up Boss) — nothing to do.
  if (!crm.moveContactToStage) return { moved: false, reason: "crm has no pipelines" };

  const { data: mapping } = await supabase
    .from("agent_pipeline_stage_map")
    .select("pipeline_id, pipeline_stage_id")
    .eq("agent_id", agentId)
    .eq("outcome", outcome)
    .maybeSingle<{ pipeline_id: string; pipeline_stage_id: string }>();

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
