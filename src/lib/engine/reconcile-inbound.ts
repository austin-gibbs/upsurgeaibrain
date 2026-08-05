// =====================================================================
// Inbound call reconciler.
//
// Inbound calls have no pre-created `calls` row (unlike outbound dials),
// so the stuck-dialing reconciler never sees them. If the Retell
// call_analyzed webhook is dropped, the lead never reaches HighLevel.
//
// For each active inbound agent with enabled automation config:
//   1. list recent ended inbound calls from Retell
//   2. diff against calls.retell_call_id
//   3. replay missing ones through processInboundCall
//
// Idempotent: processInboundCall skips already-completed rows via the
// atomic claim. Used by the worker sweep and /api/admin/reconcile-inbound-calls.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getRetellClientForAgent, type RetellCallListItem } from "@/lib/retell/client";
import { processInboundCall } from "./process-inbound";
import type { Agent } from "@/types";

export interface ReconcileInboundOptions {
  workspaceId?: string | null;
  agentId?: string | null;
  /** Look back this many hours (default 24, hard cap 72). */
  lookbackHours?: number;
  /** Max Retell calls to scan per agent (default 200, hard cap 500). */
  limitPerAgent?: number;
  dryRun?: boolean;
}

export interface ReconcileInboundSummary {
  agentsScanned: number;
  retellCallsSeen: number;
  missing: number;
  reconciled: number;
  skippedInProgress: number;
  failed: number;
  errors: Array<{ callId: string; reason: string }>;
  dryRun: boolean;
}

export async function reconcileInboundCalls(
  opts: ReconcileInboundOptions = {}
): Promise<ReconcileInboundSummary> {
  const lookbackHours = Math.min(Math.max(opts.lookbackHours ?? 24, 1), 72);
  const limitPerAgent = Math.min(opts.limitPerAgent ?? 200, 500);
  const dryRun = opts.dryRun ?? false;
  const supabase = createServiceClient();

  const summary: ReconcileInboundSummary = {
    agentsScanned: 0,
    retellCallsSeen: 0,
    missing: 0,
    reconciled: 0,
    skippedInProgress: 0,
    failed: 0,
    errors: [],
    dryRun,
  };

  // Active inbound agents that have the productized automation enabled.
  // Two-step lookup avoids brittle nested-filter syntax on the join.
  let configQuery = supabase
    .from("agent_inbound_configs")
    .select("agent_id")
    .eq("enabled", true);
  if (opts.agentId) configQuery = configQuery.eq("agent_id", opts.agentId);

  const { data: enabledConfigs, error: configError } = await configQuery;
  if (configError) {
    summary.errors.push({ callId: "*", reason: configError.message });
    return summary;
  }
  const enabledAgentIds = (enabledConfigs ?? []).map((r) => r.agent_id);
  if (enabledAgentIds.length === 0) return summary;

  let agentQuery = supabase
    .from("agents")
    .select("*")
    .eq("direction", "inbound")
    .eq("status", "active")
    .in("id", enabledAgentIds)
    .not("retell_agent_id", "is", null);

  if (opts.workspaceId) agentQuery = agentQuery.eq("workspace_id", opts.workspaceId);
  if (opts.agentId) agentQuery = agentQuery.eq("id", opts.agentId);

  const { data: agents, error: agentError } = await agentQuery.returns<Agent[]>();
  if (agentError) {
    summary.errors.push({ callId: "*", reason: agentError.message });
    return summary;
  }

  const lowerThreshold = Date.now() - lookbackHours * 60 * 60_000;

  for (const agent of agents ?? []) {
    summary.agentsScanned++;
    if (!agent.retell_agent_id) continue;

    let retellCalls: RetellCallListItem[] = [];
    try {
      const retell = getRetellClientForAgent(agent);
      retellCalls = await retell.listCalls(
        {
          filter_criteria: {
            agent_id: [agent.retell_agent_id],
            direction: ["inbound"],
            call_status: ["ended"],
            start_timestamp: { lower_threshold: lowerThreshold },
          },
          limit: limitPerAgent,
          sort_order: "descending",
        },
        1
      );
    } catch (e) {
      summary.failed++;
      summary.errors.push({
        callId: `agent:${agent.id}`,
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    summary.retellCallsSeen += retellCalls.length;
    if (retellCalls.length === 0) continue;

    const retellIds = retellCalls.map((c) => c.call_id).filter(Boolean);
    const { data: existingRows } = await supabase
      .from("calls")
      .select("retell_call_id, status")
      .eq("agent_id", agent.id)
      .eq("direction", "inbound")
      .in("retell_call_id", retellIds)
      .returns<Array<{ retell_call_id: string; status: string }>>();

    const known = new Map(
      (existingRows ?? []).map((r) => [r.retell_call_id, r.status])
    );

    for (const retellCall of retellCalls) {
      const id = retellCall.call_id;
      if (!id) continue;

      const status = known.get(id);
      if (status === "completed") continue;
      // Still being processed by a live webhook claim — leave alone.
      if (status === "dialing") {
        summary.skippedInProgress++;
        continue;
      }

      // Retell may still be analyzing; call_analyzed payload is what we need.
      // listCalls returns ended calls which usually include call_analysis, but
      // if analysis is missing, fetch the full call.
      summary.missing++;
      if (dryRun) {
        summary.reconciled++;
        continue;
      }

      try {
        let payload: RetellCallListItem | Record<string, unknown> = retellCall;
        if (!retellCall.call_analysis) {
          const retell = getRetellClientForAgent(agent);
          payload = await retell.getCall(id);
        }
        // Skip if Retell still hasn't finished analysis.
        if (!(payload as RetellCallListItem)?.call_analysis) {
          summary.skippedInProgress++;
          continue;
        }

        const result = await processInboundCall(
          { event: "call_analyzed", call: { ...payload, direction: "inbound" } },
          { finalizedBy: "reconcile" }
        );
        if (result.ok) {
          summary.reconciled++;
        } else {
          summary.failed++;
          summary.errors.push({ callId: id, reason: result.reason ?? "unknown" });
        }
      } catch (e) {
        summary.failed++;
        summary.errors.push({
          callId: id,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return summary;
}
