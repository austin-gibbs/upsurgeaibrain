// =====================================================================
// GET /api/admin/call-disposition — read-only call disposition inspector.
//
// Ops/diagnostic tool: given an internal call id (or the N most recent
// calls), returns the stored `calls` row fields AND the LIVE Retell call
// object's disposition (call_status, disconnection_reason, timestamps,
// duration). This is what tells you WHY a placed call never connected —
// e.g. dial_failed / no_answer / voicemail / telephony/billing errors —
// which the local `calls` row alone does not record.
//
// Read-only: it never writes, dispatches, or advances anything. For the
// state-changing self-heal path use /api/admin/reconcile-stuck-calls.
//
// Auth: Bearer CRON_SECRET (same as the other admin/cron routes).
// Query params:
//   callId   — a single internal calls.id to inspect
//   recent   — instead of callId, inspect the N most recent calls (cap 10)
//   agentId / workspaceId — optional filters when using `recent`
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { getRetellClientForAgent } from "@/lib/retell/client";
import type { Agent } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

const CALL_FIELDS =
  "id, workspace_id, agent_id, contact_id, to_number, status, outcome, in_voicemail, retell_call_id, error_message, finalized_by, attempt_number, phone_index, queued_at, dialed_at, completed_at";

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const callId = url.searchParams.get("callId");
  const recentParam = Number(url.searchParams.get("recent") ?? "5");
  const recent = Math.min(Number.isFinite(recentParam) ? recentParam : 5, 10);
  const agentId = url.searchParams.get("agentId");
  const workspaceId = url.searchParams.get("workspaceId");

  const supabase = createServiceClient();

  let query = supabase
    .from("calls")
    .select(CALL_FIELDS)
    .order("queued_at", { ascending: false })
    .limit(callId ? 1 : recent);
  if (callId) query = query.eq("id", callId);
  if (agentId) query = query.eq("agent_id", agentId);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data: calls, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!calls || calls.length === 0) {
    return NextResponse.json({ calls: [] });
  }

  const agentCache = new Map<string, Agent | null>();
  async function loadAgent(id: string): Promise<Agent | null> {
    if (agentCache.has(id)) return agentCache.get(id)!;
    const { data } = await supabase
      .from("agents")
      .select("*")
      .eq("id", id)
      .single<Agent>();
    agentCache.set(id, data ?? null);
    return data ?? null;
  }

  const out = [];
  for (const c of calls as Array<Record<string, unknown>>) {
    const row = {
      callId: c.id,
      status: c.status,
      outcome: c.outcome,
      in_voicemail: c.in_voicemail,
      to_number: c.to_number,
      retell_call_id: c.retell_call_id,
      error_message: c.error_message,
      finalized_by: c.finalized_by,
      attempt_number: c.attempt_number,
      dialed_at: c.dialed_at,
      completed_at: c.completed_at,
      retell: null as unknown,
    };

    if (c.retell_call_id) {
      try {
        const agent = await loadAgent(c.agent_id as string);
        if (!agent) {
          row.retell = { error: "agent not found — cannot pick Retell key" };
        } else {
          const client = getRetellClientForAgent(agent);
          const rc = await client.getCall(c.retell_call_id as string);
          row.retell = {
            call_status: rc?.call_status,
            disconnection_reason: rc?.disconnection_reason,
            from_number: rc?.from_number,
            to_number: rc?.to_number,
            direction: rc?.direction,
            start_timestamp: rc?.start_timestamp,
            end_timestamp: rc?.end_timestamp,
            duration_ms:
              rc?.end_timestamp && rc?.start_timestamp
                ? rc.end_timestamp - rc.start_timestamp
                : null,
            has_recording: Boolean(rc?.recording_url),
            call_analysis_summary: rc?.call_analysis?.call_summary ?? null,
          };
        }
      } catch (e) {
        row.retell = {
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    out.push(row);
  }

  return NextResponse.json({ count: out.length, calls: out });
}
