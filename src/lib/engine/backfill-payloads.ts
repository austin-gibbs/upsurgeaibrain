// =====================================================================
// Call-payload backfill.
//
// Fixes the "missing raw_payload" capture gap that under-counts the
// fulfillment report's month-to-date minutes and Retell spend.
//
// The fulfillment report derives per-workspace MTD minutes and spend
// *only* from each call's stored Retell webhook body (`raw_payload` →
// duration_ms + call_cost.combined_cost). A call that finished (status
// `completed`, outcome already classified) but whose `call_analyzed`
// webhook never persisted its body contributes ZERO minutes and ZERO
// spend — so app totals drift below Retell's own usage dashboard.
// The workspace reporting route already surfaces the count of these as
// `meta.missingRawPayload`.
//
// The stuck-call reconciler (reconcile.ts) does NOT cover this: it only
// touches rows still in `dialing`, and re-running the full outcome
// processor on a `completed` row is a no-op (it skips completed).
//
// This backfill re-fetches each affected call from Retell and patches
// ONLY `raw_payload` (enveloped `{ event, call }` shape, matching the
// live webhook + the report's JSON paths). It deliberately does not
// re-run CRM writeback, tag reconciliation, or cadence — the outcome
// column is already set on completed rows, so patching the payload is
// enough to make minutes/spend match Retell without side effects.
//
// Manual test calls placed directly in the Retell dashboard have no
// `calls` row (the table requires contact_id/agent_id), so they are out
// of scope by design — that residual is genuine non-fulfillment usage.
//
// Auth-exposed via POST /api/admin/backfill-call-payloads (CRON_SECRET).
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getRetellClientForAgent } from "@/lib/retell/client";
import type { Agent } from "@/types";

export interface BackfillPayloadOptions {
  workspaceId?: string | null;
  agentId?: string | null;
  /**
   * Only backfill calls completed at/after this ISO instant. Defaults to
   * the start of the current UTC month — the window the twice-daily
   * fulfillment report cares about.
   */
  sinceIso?: string | null;
  /** Max rows to scan in one pass (hard cap 1000). */
  limit?: number;
  /** Report what would be patched, and how many minutes/$ it recovers, without writing. */
  dryRun?: boolean;
}

export interface BackfillPayloadSummary {
  scanned: number;
  patched: number;
  skippedNoAgent: number;
  skippedNoRetellCall: number;
  failed: number;
  /** Talk minutes that were previously missing and are now (or would be) recovered. */
  minutesRecovered: number;
  /** Retell spend (USD) that was previously missing and is now (or would be) recovered. */
  spendRecoveredUsd: number;
  errors: Array<{ callId: string; reason: string }>;
  dryRun: boolean;
}

/** Coerce Retell's string|number cost/duration fields to a finite number (0 on junk). */
function toNumber(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Pure: talk seconds + spend (USD) recoverable from a bare Retell call object.
 * Mirrors the fulfillment report's own logic — prefer wall-clock duration_ms,
 * fall back to billed total_duration_seconds; combined_cost is in CENTS.
 * Accepts either the bare call or an enveloped `{ call }` shape defensively.
 */
export function recoveredFromCall(raw: unknown): { seconds: number; costUsd: number } {
  const root = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  const call = (
    root.call && typeof root.call === "object" ? (root.call as Record<string, unknown>) : root
  ) as Record<string, unknown>;
  const cost = (
    call.call_cost && typeof call.call_cost === "object"
      ? (call.call_cost as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;

  const durMs = toNumber(call.duration_ms);
  const seconds = durMs > 0 ? durMs / 1000 : toNumber(cost.total_duration_seconds);
  const costUsd = toNumber(cost.combined_cost) / 100;
  return { seconds, costUsd };
}

function startOfCurrentUtcMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)).toISOString();
}

interface BackfillCallRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  retell_call_id: string | null;
}

export async function backfillCallPayloads(
  opts: BackfillPayloadOptions = {}
): Promise<BackfillPayloadSummary> {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const dryRun = opts.dryRun ?? false;
  const sinceIso = opts.sinceIso || startOfCurrentUtcMonthIso();
  const supabase = createServiceClient();

  const summary: BackfillPayloadSummary = {
    scanned: 0,
    patched: 0,
    skippedNoAgent: 0,
    skippedNoRetellCall: 0,
    failed: 0,
    minutesRecovered: 0,
    spendRecoveredUsd: 0,
    errors: [],
    dryRun,
  };

  // Completed calls in the window that never got their webhook body stored.
  let query = supabase
    .from("calls")
    .select("id, workspace_id, agent_id, retell_call_id")
    .eq("status", "completed")
    .is("raw_payload", null)
    .not("retell_call_id", "is", null)
    .gte("completed_at", sinceIso)
    .order("completed_at", { ascending: true })
    .limit(limit);
  if (opts.workspaceId) query = query.eq("workspace_id", opts.workspaceId);
  if (opts.agentId) query = query.eq("agent_id", opts.agentId);

  const { data: calls, error } = await query.returns<BackfillCallRow[]>();
  if (error) {
    summary.errors.push({ callId: "*", reason: error.message });
    return summary;
  }
  summary.scanned = calls?.length ?? 0;

  // One Retell client per agent, not per call.
  const agentCache = new Map<string, Agent | null>();
  async function loadAgent(id: string): Promise<Agent | null> {
    if (agentCache.has(id)) return agentCache.get(id)!;
    const { data } = await supabase.from("agents").select("*").eq("id", id).single<Agent>();
    agentCache.set(id, data ?? null);
    return data ?? null;
  }

  for (const call of calls ?? []) {
    try {
      if (!call.retell_call_id) {
        summary.skippedNoRetellCall++;
        continue;
      }
      const agent = await loadAgent(call.agent_id);
      if (!agent) {
        summary.skippedNoAgent++;
        continue;
      }

      const retell = getRetellClientForAgent(agent);
      const retellCall = await retell.getCall(call.retell_call_id);
      const { seconds, costUsd } = recoveredFromCall(retellCall);

      if (!dryRun) {
        // Store the enveloped shape the live webhook + report expect.
        const { error: upErr } = await supabase
          .from("calls")
          .update({ raw_payload: { event: "call_analyzed", call: retellCall } })
          .eq("id", call.id)
          .is("raw_payload", null); // guard against racing a late webhook
        if (upErr) {
          summary.failed++;
          summary.errors.push({ callId: call.id, reason: upErr.message });
          continue;
        }
      }

      summary.patched++;
      summary.minutesRecovered += seconds / 60;
      summary.spendRecoveredUsd += costUsd;
    } catch (e: unknown) {
      summary.failed++;
      summary.errors.push({
        callId: call.id,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Round the aggregate figures for a tidy summary payload.
  summary.minutesRecovered = Math.round(summary.minutesRecovered);
  summary.spendRecoveredUsd = Math.round(summary.spendRecoveredUsd * 100) / 100;
  return summary;
}
