// =====================================================================
// Caller — places a single outbound call.
//
// Runs in the call worker. Loads agent + contact + memory, injects V2
// dynamic variables, creates the Retell call, writes a `calls` row in
// `dialing` status, marks the contact dialed in the CRM, and stamps the
// attempt. Outcome processing happens later via the Retell webhook.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { getRetellClientForAgent } from "@/lib/retell/client";
import { appRetellWebhookUrl } from "@/lib/retell/webhook-bind";
import { buildDynamicVariables } from "./memory";
import { todayInTz, evaluateDialWindow } from "./cadence";
import { cancelQueueEntries, markQueueDialing } from "./call-queue";
import { getCallQueue, type CallJob } from "@/lib/queue/queues";
import type { Agent, AgentMemory, Contact, Workspace } from "@/types";

/**
 * Thrown by placeCall when it is asked to dial outside the calling window.
 * The worker catches this and DEFERS the job to the next window open instead of
 * marking it failed. Because the throw happens BEFORE the `calls` row is written
 * and BEFORE any Retell call is created, a dial can never be placed outside the
 * window regardless of which caller invoked placeCall (worker, script, manual).
 */
export class OutsideCallWindowError extends Error {
  readonly deferMs: number;
  readonly reason: string;
  constructor(reason: string, deferMs: number) {
    super(reason);
    this.name = "OutsideCallWindowError";
    this.deferMs = deferMs;
    this.reason = reason;
  }
}

/**
 * Remove any not-yet-running dial jobs for a specific contact from the call
 * queue. Used by the manual "Call now" test so forcing an immediate dial can't
 * be followed by a second, scheduled dial for the same contact. Only pending
 * states are scanned (active/locked jobs are left alone), and only jobs for
 * this exact agent+contact are removed — the rest of the queue is untouched.
 * Returns the number of jobs removed.
 */
export async function cancelPendingDials(
  agentId: string,
  contactId: string
): Promise<number> {
  // Call-now runs on Vercel where Redis may be absent; skipping is safe —
  // the inline dial still proceeds and duplicate prevention is best-effort.
  if (!process.env.REDIS_URL) return 0;

  try {
    const queue = getCallQueue();
    const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"]);
    let removed = 0;
    for (const job of jobs) {
      if (job?.data?.contactId === contactId && job.data.agentId === agentId) {
        try {
          await job.remove();
          removed++;
        } catch {
          // Job may have started running between the scan and removal — skip it.
        }
      }
    }
    if (removed > 0) {
      const supabase = createServiceClient();
      await cancelQueueEntries(supabase, { agentId, contactId });
    }
    return removed;
  } catch {
    return 0;
  }
}

export async function placeCall(job: CallJob): Promise<{ callId: string; retellCallId: string }> {
  const supabase = createServiceClient();

  const { data: agent } = await supabase
    .from("agents").select("*").eq("id", job.agentId).single<Agent>();
  if (!agent) throw new Error(`agent ${job.agentId} not found`);
  if (!agent.retell_agent_id || !agent.retell_from_number) {
    throw new Error(`agent ${job.agentId} missing Retell linkage`);
  }

  const { data: contact } = await supabase
    .from("contacts").select("*").eq("id", job.contactId).single<Contact>();
  if (!contact) throw new Error(`contact ${job.contactId} not found`);
  if (contact.workspace_id !== agent.workspace_id) {
    throw new Error(
      `contact ${job.contactId} belongs to workspace ${contact.workspace_id}, not agent workspace ${agent.workspace_id}`
    );
  }
  if (contact.is_terminal) {
    throw new Error(`contact ${job.contactId} is terminal — skipping`);
  }
  if (!job.toNumber?.trim()) {
    throw new Error(`contact ${job.contactId} has no dial number`);
  }

  const { data: workspace } = await supabase
    .from("workspaces").select("*").eq("id", agent.workspace_id).single<Workspace>();
  if (!workspace) throw new Error(`workspace ${agent.workspace_id} not found`);

  // ── Authoritative call-window guard ────────────────────────────────────────
  // This is the LAST line of defense before a dial, and it runs BEFORE the
  // `calls` row is inserted and BEFORE the Retell call is created. Even if the
  // worker's pre-check passed and the clock then crossed the window boundary, or
  // a script/manual path calls placeCall directly, we refuse here. Test-mode
  // dials bypass by design (they're operator-initiated end-to-end checks).
  if (!job.testMode) {
    const { data: callConfig } = await supabase
      .from("agent_call_configs")
      .select("call_window_start, call_window_end, call_window_days")
      .eq("agent_id", agent.id)
      .maybeSingle<{
        call_window_start: string;
        call_window_end: string;
        call_window_days: number[];
      }>();
    const decision = evaluateDialWindow(
      workspace.timezone,
      callConfig?.call_window_start,
      callConfig?.call_window_end,
      callConfig?.call_window_days
    );
    if (!decision.allowed) {
      throw new OutsideCallWindowError(decision.reason, decision.deferMs);
    }
  }

  // Idempotency: a BullMQ retry (attempts: 3) re-runs placeCall with the same
  // attempt number. If this (agent, contact, attempt) already placed a real
  // Retell call, do NOT place another — that would dial the person twice and
  // cost real money. Return the existing dial instead.
  const { data: alreadyDialed } = await supabase
    .from("calls")
    .select("id, retell_call_id")
    .eq("agent_id", agent.id)
    .eq("contact_id", contact.id)
    .eq("attempt_number", job.attemptNumber)
    .in("status", ["dialing", "completed"])
    .not("retell_call_id", "is", null)
    .maybeSingle<{ id: string; retell_call_id: string | null }>();
  if (alreadyDialed?.retell_call_id) {
    return { callId: alreadyDialed.id, retellCallId: alreadyDialed.retell_call_id };
  }

  const { data: memory } = await supabase
    .from("agent_memory").select("*")
    .eq("agent_id", job.agentId).eq("contact_id", job.contactId)
    .maybeSingle<AgentMemory>();

  // Record the call row first so the webhook can correlate even on a race.
  // Reuse a leftover `queued` row from a prior failed attempt (same agent +
  // contact + attempt) instead of inserting a new one, so retries don't leave
  // orphan `queued` rows behind.
  const { data: orphanQueued } = await supabase
    .from("calls")
    .select("id")
    .eq("agent_id", agent.id)
    .eq("contact_id", contact.id)
    .eq("attempt_number", job.attemptNumber)
    .eq("status", "queued")
    .maybeSingle<{ id: string }>();

  let call: { id: string } | null = orphanQueued ?? null;
  if (!call) {
    const inserted = await supabase
      .from("calls")
      .insert({
        workspace_id: workspace.id,
        agent_id: agent.id,
        contact_id: contact.id,
        attempt_number: job.attemptNumber,
        to_number: job.toNumber,
        status: "queued",
      })
      .select("id")
      .single<{ id: string }>();
    if (inserted.error?.code === "23505") {
      const { data: conflict } = await supabase
        .from("calls")
        .select("id, retell_call_id, status")
        .eq("agent_id", agent.id)
        .eq("contact_id", contact.id)
        .eq("attempt_number", job.attemptNumber)
        .in("status", ["queued", "dialing", "completed"])
        .maybeSingle<{ id: string; retell_call_id: string | null; status: string }>();
      if (conflict?.retell_call_id) {
        return { callId: conflict.id, retellCallId: conflict.retell_call_id };
      }
      if (conflict?.status === "queued") {
        call = { id: conflict.id };
      } else {
        throw new Error(
          `duplicate active call row for agent ${agent.id} contact ${contact.id} attempt ${job.attemptNumber}`
        );
      }
    } else {
      call = inserted.data;
    }
  }
  if (!call) throw new Error("failed to create call row");

  // Inject V2 memory + identity into the Retell prompt.
  let dynamicVariables = buildDynamicVariables({
    agent,
    contact,
    memory: memory ?? null,
    attemptNumber: job.attemptNumber,
  });

  // Best-effort: enrich with the contact's CRM field values (e.g. HighLevel
  // custom fields like interested campus/program) so the prompt can reference
  // them as {{...}} dynamic variables. Strictly additive — base identity/memory
  // variables win on any key collision, and any failure (no CRM connected, API
  // error) leaves the base variables untouched so the dial still proceeds.
  try {
    const crmForVars = getCrmAdapterForAgent(agent, workspace);
    if (typeof crmForVars.getContactFieldValues === "function" && contact.crm_contact_id) {
      const fieldVars = await crmForVars.getContactFieldValues(contact.crm_contact_id);
      dynamicVariables = { ...fieldVars, ...dynamicVariables };
    }
  } catch {
    // non-fatal — proceed with base dynamic variables only
  }

  const retell = getRetellClientForAgent(agent);
  const webhookUrl = appRetellWebhookUrl();

  const { callId: retellCallId } = await retell.createPhoneCall({
    fromNumber: agent.retell_from_number,
    toNumber: job.toNumber,
    agentId: agent.retell_agent_id,
    dynamicVariables,
    metadata: { call_id: call.id, workspace_id: workspace.id, agent_id: agent.id },
    webhookUrl,
  });

  const today = todayInTz(workspace.timezone);

  await supabase
    .from("calls")
    .update({ retell_call_id: retellCallId, status: "dialing", dialed_at: new Date().toISOString() })
    .eq("id", call.id);

  await markQueueDialing(supabase, {
    agentId: agent.id,
    contactId: contact.id,
    callId: call.id,
    queueDay: today,
  });

  // Stamp the attempt + mark dialed-today so the same-day filter excludes it.
  await supabase
    .from("contacts")
    .update({ attempt_count: job.attemptNumber, last_called_on: today })
    .eq("id", contact.id);

  // Best-effort CRM "dialed" marker (mirrors WF1's Mark Contact Dialed).
  try {
    const crm = getCrmAdapterForAgent(agent, workspace);
    const dialedTag = `upsurgecalled${today.replace(/-/g, "")}`;
    if (!contact.tags.includes(dialedTag) && contact.crm_contact_id) {
      await crm.setTags(
        contact.crm_contact_id,
        Array.from(new Set([...contact.tags, dialedTag]))
      );
    }
  } catch {
    // non-fatal — the local last_called_on already guards same-day re-dials
  }

  return { callId: call.id, retellCallId };
}

/**
 * Place a one-off TEST call to an arbitrary number, synchronously and outside
 * the BullMQ call queue.
 *
 * This exists so an operator can verify an outbound agent end-to-end without a
 * CRM contact and without competing with (or disrupting) the live dial queue.
 * It deliberately has NO side effects beyond the call itself: it does not touch
 * the contacts table, does not write CRM tags/notes, and does not advance any
 * cadence. The `calls` row it writes has a null contact_id; the outcome webhook
 * recognises that and finalises the record without CRM/cadence/memory writes.
 */
export async function placeTestCall(params: {
  agentId: string;
  toNumber: string;
}): Promise<{ callId: string; retellCallId: string }> {
  const supabase = createServiceClient();

  const { data: agent } = await supabase
    .from("agents").select("*").eq("id", params.agentId).single<Agent>();
  if (!agent) throw new Error(`agent ${params.agentId} not found`);
  if (!agent.retell_agent_id || !agent.retell_from_number) {
    throw new Error(`agent ${params.agentId} missing Retell linkage`);
  }

  const { data: workspace } = await supabase
    .from("workspaces").select("*").eq("id", agent.workspace_id).single<Workspace>();
  if (!workspace) throw new Error(`workspace ${agent.workspace_id} not found`);

  const { data: call } = await supabase
    .from("calls")
    .insert({
      workspace_id: workspace.id,
      agent_id: agent.id,
      contact_id: null,
      attempt_number: 1,
      to_number: params.toNumber,
      status: "queued",
      direction: "outbound",
    })
    .select("id")
    .single<{ id: string }>();
  if (!call) throw new Error("failed to create call row");

  // Minimal dynamic variables — mirrors buildDynamicVariables keys so the
  // agent prompt resolves, with a test marker and no contact identity/memory.
  const dynamicVariables: Record<string, string> = {
    contact_name: "there",
    objective: agent.objective ?? "",
    attempt_number: "1",
    is_returning_contact: "false",
    prior_call_count: "0",
    memory_summary: "",
    known_facts: "{}",
    is_test_call: "true",
  };

  const retell = getRetellClientForAgent(agent);
  const { callId: retellCallId } = await retell.createPhoneCall({
    fromNumber: agent.retell_from_number,
    toNumber: params.toNumber,
    agentId: agent.retell_agent_id,
    dynamicVariables,
    metadata: {
      call_id: call.id,
      workspace_id: workspace.id,
      agent_id: agent.id,
      test_call: "true",
    },
    webhookUrl: appRetellWebhookUrl(),
  });

  await supabase
    .from("calls")
    .update({
      retell_call_id: retellCallId,
      status: "dialing",
      dialed_at: new Date().toISOString(),
    })
    .eq("id", call.id);

  return { callId: call.id, retellCallId };
}
