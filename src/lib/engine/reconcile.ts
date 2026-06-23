// =====================================================================
// Stuck-call reconciler.
//
// Finalizes calls left in `dialing` because their Retell `call_analyzed`
// webhook was never successfully processed (e.g. a webhook-signature
// mismatch returned 401 before the outcome handler ran, so the recording +
// notes never reached the CRM).
//
// For each stuck call we fetch the final call object from Retell and feed
// it through the SAME outcome processor the live webhook uses, so CRM log
// (recording + notes), tag reconciliation, cadence advance and V2 memory
// all run with full parity. Idempotent: `processRetellWebhook` skips rows
// already `completed`, and calls still in progress are left untouched.
//
// Used by:
//   - the admin backfill route (POST /api/admin/reconcile-stuck-calls)
//   - the worker's periodic self-heal sweep (worker/index.ts)
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getRetellClientForAgent } from "@/lib/retell/client";
import { processRetellWebhook } from "./process-outcome";
import { logReconcileHealthWarning } from "./reconcile-health";
import type { Agent } from "@/types";

export interface ReconcileOptions {
  workspaceId?: string | null;
  agentId?: string | null;
  /** Max rows to scan in one pass (hard cap 500). */
  limit?: number;
  /** Only touch calls dialed at least this long ago (protects in-flight calls). */
  olderThanMinutes?: number;
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
}

export interface ReconcileSummary {
  scanned: number;
  reconciled: number;
  skippedInProgress: number;
  skippedNoAgent: number;
  failed: number;
  errors: Array<{ callId: string; reason: string }>;
  dryRun: boolean;
}

export async function reconcileStuckCalls(
  opts: ReconcileOptions = {}
): Promise<ReconcileSummary> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const dryRun = opts.dryRun ?? false;
  const supabase = createServiceClient();

  let query = supabase
    .from("calls")
    .select("id, workspace_id, agent_id, retell_call_id, status")
    .eq("status", "dialing")
    .not("retell_call_id", "is", null)
    .order("dialed_at", { ascending: true })
    .limit(limit);
  if (opts.workspaceId) query = query.eq("workspace_id", opts.workspaceId);
  if (opts.agentId) query = query.eq("agent_id", opts.agentId);
  if (opts.olderThanMinutes && opts.olderThanMinutes > 0) {
    const cutoff = new Date(Date.now() - opts.olderThanMinutes * 60_000).toISOString();
    query = query.lt("dialed_at", cutoff);
  }

  const summary: ReconcileSummary = {
    scanned: 0,
    reconciled: 0,
    skippedInProgress: 0,
    skippedNoAgent: 0,
    failed: 0,
    errors: [],
    dryRun,
  };

  const { data: calls, error } = await query;
  if (error) {
    summary.errors.push({ callId: "*", reason: error.message });
    return summary;
  }
  summary.scanned = calls?.length ?? 0;

  // Cache agent rows so we build one Retell client per agent, not per call.
  const agentCache = new Map<string, Agent | null>();
  async function loadAgent(id: string): Promise<Agent | null> {
    if (agentCache.has(id)) return agentCache.get(id)!;
    const { data } = await supabase.from("agents").select("*").eq("id", id).single<Agent>();
    agentCache.set(id, data ?? null);
    return data ?? null;
  }

  for (const call of calls ?? []) {
    try {
      const agent = await loadAgent(call.agent_id);
      if (!agent) {
        summary.skippedNoAgent++;
        continue;
      }

      const retell = getRetellClientForAgent(agent);
      const retellCall = await retell.getCall(call.retell_call_id as string);

      // Leave still-running calls alone — their live webhook will finalize them.
      const status: string | undefined = retellCall?.call_status;
      if (status === "ongoing" || status === "registered") {
        summary.skippedInProgress++;
        continue;
      }

      if (dryRun) {
        summary.reconciled++;
        continue;
      }

      const result = await processRetellWebhook(
        { event: "call_analyzed", call: retellCall },
        { finalizedBy: "reconcile" }
      );
      if (result.ok) {
        summary.reconciled++;
      } else {
        summary.failed++;
        summary.errors.push({ callId: call.id, reason: result.reason ?? "unknown" });
      }
    } catch (e: unknown) {
      summary.failed++;
      summary.errors.push({
        callId: call.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (!dryRun && summary.reconciled > 0) {
    await logReconcileHealthWarning(supabase, summary.reconciled);
  }

  return summary;
}
