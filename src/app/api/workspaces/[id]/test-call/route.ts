// =====================================================================
// POST /api/workspaces/:id/test-call — place ONE outbound test call now,
// regardless of call windows or cadence timing. Both modes dial INLINE
// (straight to Retell) and never enqueue a job, so the live BullMQ call
// queue and the contacts scheduled in it are completely undisturbed.
//
//   { agentId, toNumber }   → dials an arbitrary number. No contact, no CRM
//                             write-back. Pure connectivity test.
//   { agentId, contactId }  → dials an existing enrolled contact. Runs the
//                             full downstream pipeline (FUB note/tags/task +
//                             cadence + memory) for THAT contact via the
//                             webhook, exactly like a real dial — just not
//                             routed through the queue.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { cancelPendingDials, placeCall, placeTestCall } from "@/lib/engine/caller";
import { testCallSchema } from "@/lib/validation";
import {
  contactHasEnrollTag,
  effectiveEnrollTag,
} from "@/lib/agents/enroll-tag";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = createServerClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // RLS scopes this to workspaces the caller can see.
  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .select("id, enroll_tag")
    .eq("id", params.id)
    .single<{ id: string; enroll_tag: string }>();
  if (wsErr || !workspace) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const json = await req.json().catch(() => ({}));
  const parsed = testCallSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { agentId, contactId, toNumber } = parsed.data;

  const { data: agent } = await db
    .from("agents")
    .select("id, direction, enroll_tag, retell_agent_id, retell_from_number")
    .eq("id", agentId)
    .eq("workspace_id", params.id)
    .single<{
      id: string;
      direction: "inbound" | "outbound";
      enroll_tag: string | null;
      retell_agent_id: string | null;
      retell_from_number: string | null;
    }>();
  if (!agent) {
    return NextResponse.json(
      { error: "agent not found in this workspace" },
      { status: 404 }
    );
  }
  if (agent.direction !== "outbound") {
    return NextResponse.json(
      { error: "only outbound agents can place test calls" },
      { status: 400 }
    );
  }
  if (!agent.retell_agent_id || !agent.retell_from_number) {
    return NextResponse.json(
      { error: "agent is missing its Retell agent ID or from number" },
      { status: 400 }
    );
  }

  // ---- Ad-hoc number mode: dial inline, no contact / CRM / queue ----------
  if (toNumber) {
    try {
      const { callId, retellCallId } = await placeTestCall({ agentId, toNumber });
      return NextResponse.json({ ok: true, mode: "adhoc", callId, retellCallId, toNumber });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "test call failed" },
        { status: 502 }
      );
    }
  }

  // ---- Enrolled-contact mode: dial inline (no queue) ----------------------
  if (!contactId) {
    return NextResponse.json(
      { error: "provide either a contact or a phone number" },
      { status: 400 }
    );
  }

  const { data: contact } = await db
    .from("contacts")
    .select("id, full_name, phones, tags, attempt_count, is_terminal")
    .eq("id", contactId)
    .eq("workspace_id", params.id)
    .single<{
      id: string;
      full_name: string | null;
      phones: string[];
      tags: string[];
      attempt_count: number;
      is_terminal: boolean;
    }>();
  if (!contact) {
    return NextResponse.json(
      { error: "contact not found in this workspace" },
      { status: 404 }
    );
  }

  const enrollTag = effectiveEnrollTag(agent.enroll_tag, workspace.enroll_tag);
  if (!contactHasEnrollTag(contact.tags, enrollTag)) {
    return NextResponse.json(
      {
        error: `Contact is not enrolled with tag "${enrollTag}" for this agent.`,
      },
      { status: 400 }
    );
  }

  if (contact.is_terminal) {
    return NextResponse.json(
      { error: "contact has already completed the flow" },
      { status: 400 }
    );
  }
  const dialNumber = contact.phones?.[0];
  if (!dialNumber) {
    return NextResponse.json(
      { error: "contact has no phone number" },
      { status: 400 }
    );
  }

  // Drop any pending scheduled dial for this contact first so forcing the call
  // now can't be followed by a duplicate dial later. Only this contact's jobs
  // are removed — the rest of the queue is untouched.
  const cancelledQueued = await cancelPendingDials(agentId, contactId);

  // Dial directly via placeCall (same path the worker uses), bypassing the
  // BullMQ call queue entirely — forces the call now without enqueuing a job
  // or competing with scheduled dials. placeCall does no call-window checks,
  // so time parameters are ignored. The webhook handles full FUB write-back.
  try {
    const { callId, retellCallId } = await placeCall({
      agentId,
      contactId,
      toNumber: dialNumber,
      attemptNumber: contact.attempt_count + 1,
      testMode: true,
    });
    return NextResponse.json({
      ok: true,
      mode: "contact",
      callId,
      retellCallId,
      toNumber: dialNumber,
      contactName: contact.full_name,
      cancelledQueued,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "test call failed" },
      { status: 502 }
    );
  }
}
