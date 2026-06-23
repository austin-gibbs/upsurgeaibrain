// =====================================================================
// Poller — the n8n "Call Initiator (WF1)" replacement.
//
// For one agent: pull enrolled contacts from the CRM, reconcile them into
// our `contacts` cache, filter for eligibility, and enqueue one `call` job
// per eligible contact with a drip-throttle delay so dials are spaced out.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { getCallQueue } from "@/lib/queue/queues";
import {
  isEligible,
  msUntilCallWindowOpens,
  remainingWindowCapacity,
  todayInTz,
  withinCallWindow,
} from "./cadence";
import type { Agent, AgentCallConfig, Contact, Workspace } from "@/types";

export interface PollOptions {
  testMode?: boolean;
}

export interface PollResult {
  agentId: string;
  scanned: number;
  eligible: number;
  enqueued: number;
  skippedReason?: string;
}

export async function pollAgent(
  agentId: string,
  options?: PollOptions
): Promise<PollResult> {
  const supabase = createServiceClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single<Agent>();
  if (!agent) return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "agent not found" };
  if (agent.direction === "inbound") {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "inbound agent" };
  }
  if (agent.status !== "active") {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: `agent ${agent.status}` };
  }

  const { data: config } = await supabase
    .from("agent_call_configs")
    .select("*")
    .eq("agent_id", agentId)
    .single<AgentCallConfig>();
  if (!config) return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "no call config" };

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", agent.workspace_id)
    .single<Workspace>();
  if (!workspace || !workspace.is_active) {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "workspace inactive" };
  }

  if (
    !options?.testMode &&
    !withinCallWindow(workspace.timezone, config.call_window_start, config.call_window_end)
  ) {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "outside call window" };
  }

  const today = todayInTz(workspace.timezone);
  const crm = getCrmAdapterForAgent(agent, workspace);

  // 1. Pull everyone carrying this agent's enroll tag (falls back to workspace tag).
  const enrollTag = agent.enroll_tag ?? workspace.enroll_tag;
  const crmContacts = await crm.getContactsByTag(enrollTag);

  // 2. Upsert into our cache, preserving cadence state we already track.
  const contacts: Contact[] = [];
  for (const c of crmContacts) {
    const { data: existing } = await supabase
      .from("contacts")
      .select("*")
      .eq("workspace_id", workspace.id)
      .eq("crm_contact_id", c.id)
      .maybeSingle<Contact>();

    const merged = {
      workspace_id: workspace.id,
      crm_contact_id: c.id,
      full_name: c.fullName,
      email: c.email,
      phones: c.phones,
      tags: c.tags,
      // Preserve engine-owned cadence fields if the row exists.
      attempt_count: existing?.attempt_count ?? 0,
      last_called_on: existing?.last_called_on ?? null,
      next_eligible_on: existing?.next_eligible_on ?? null,
      is_terminal: existing?.is_terminal ?? false,
      terminal_outcome: existing?.terminal_outcome ?? null,
    };

    const { data: saved } = await supabase
      .from("contacts")
      .upsert(merged, { onConflict: "workspace_id,crm_contact_id" })
      .select("*")
      .single<Contact>();
    if (saved) contacts.push(saved);
  }

  // 3. Filter eligible, sort for fair rollover, cap to what fits today's window.
  const eligible = contacts
    .filter((c) => isEligible(c, config, today) && c.phones.length > 0)
    .sort((a, b) => {
      const na = a.next_eligible_on ?? "0000-00-00";
      const nb = b.next_eligible_on ?? "0000-00-00";
      if (na !== nb) return na.localeCompare(nb);
      return a.attempt_count - b.attempt_count;
    });

  const windowCapacity = options?.testMode
    ? config.max_calls_per_day
    : remainingWindowCapacity(
        workspace.timezone,
        config.call_window_start,
        config.call_window_end,
        config.drip_seconds
      );
  const dailyCap = Math.min(config.max_calls_per_day, windowCapacity);
  const capped = eligible.slice(0, dailyCap);

  const baseDelay = options?.testMode
    ? 0
    : msUntilCallWindowOpens(
        workspace.timezone,
        config.call_window_start,
        config.call_window_end
      );

  // 4. Enqueue with drip throttle anchored to window open.
  const queue = getCallQueue();
  let enqueued = 0;
  for (let i = 0; i < capped.length; i++) {
    const contact = capped[i];
    await queue.add(
      "dial",
      {
        agentId,
        contactId: contact.id,
        toNumber: contact.phones[0],
        attemptNumber: contact.attempt_count + 1,
        testMode: options?.testMode,
      },
      {
        delay: baseDelay + i * config.drip_seconds * 1000,
        jobId: `${agentId}:${contact.id}:${today}`, // idempotent per day
      }
    );
    enqueued++;
  }

  return { agentId, scanned: contacts.length, eligible: eligible.length, enqueued };
}

export interface QueueContactsResult {
  agentId: string;
  requested: number;
  eligible: number;
  enqueued: number;
  capped: number;
  skippedReason?: string;
}

/**
 * Manually enqueue a hand-picked set of contacts into the live call queue
 * right now, drip-spaced at the agent's `drip_seconds`. This is the engine
 * behind the Ops "Queue calls now" bulk action.
 *
 * Unlike the poller it does NOT scan the CRM and deliberately bypasses the
 * cadence "already called today / not yet due" gate — the operator is pulling
 * these contacts back in on purpose. It still honors the hard safety rails:
 * terminal contacts and contacts without a phone are dropped, the call window
 * must be open, and the batch is capped to what fits before the window closes.
 * The per-day manual jobId keeps repeated clicks idempotent.
 */
export async function enqueueContactsNow(
  agentId: string,
  contactIds: string[]
): Promise<QueueContactsResult> {
  const supabase = createServiceClient();
  const requested = contactIds.length;
  const base = { agentId, requested, eligible: 0, enqueued: 0, capped: 0 };

  const { data: agent } = await supabase
    .from("agents").select("*").eq("id", agentId).single<Agent>();
  if (!agent) return { ...base, skippedReason: "agent not found" };
  if (agent.direction === "inbound") return { ...base, skippedReason: "inbound agent" };
  if (agent.status !== "active") return { ...base, skippedReason: `agent ${agent.status}` };
  if (!agent.retell_agent_id || !agent.retell_from_number) {
    return { ...base, skippedReason: "agent missing Retell linkage" };
  }

  const { data: config } = await supabase
    .from("agent_call_configs").select("*").eq("agent_id", agentId).single<AgentCallConfig>();
  if (!config) return { ...base, skippedReason: "no call config" };

  const { data: workspace } = await supabase
    .from("workspaces").select("*").eq("id", agent.workspace_id).single<Workspace>();
  if (!workspace || !workspace.is_active) {
    return { ...base, skippedReason: "workspace inactive" };
  }

  if (!withinCallWindow(workspace.timezone, config.call_window_start, config.call_window_end)) {
    return { ...base, skippedReason: "outside call window" };
  }

  const today = todayInTz(workspace.timezone);

  const { data: rows } = await supabase
    .from("contacts")
    .select("*")
    .eq("workspace_id", workspace.id)
    .in("id", contactIds)
    .returns<Contact[]>();

  const dialable = (rows ?? []).filter((c) => !c.is_terminal && c.phones.length > 0);
  const eligible = dialable.length;

  const capacity = remainingWindowCapacity(
    workspace.timezone,
    config.call_window_start,
    config.call_window_end,
    config.drip_seconds
  );
  const toQueue = dialable.slice(0, Math.max(capacity, 0));
  const capped = eligible - toQueue.length;

  const queue = getCallQueue();
  let enqueued = 0;
  for (let i = 0; i < toQueue.length; i++) {
    const contact = toQueue[i];
    await queue.add(
      "dial",
      {
        agentId,
        contactId: contact.id,
        toNumber: contact.phones[0],
        attemptNumber: contact.attempt_count + 1,
      },
      {
        delay: i * config.drip_seconds * 1000,
        jobId: `manual:${agentId}:${contact.id}:${today}`, // idempotent per day
      }
    );
    enqueued++;
  }

  return { agentId, requested, eligible, enqueued, capped };
}

/** Poll every active outbound agent in a workspace. */
export async function pollWorkspace(
  workspaceId: string,
  options?: PollOptions
): Promise<PollResult[]> {
  const supabase = createServiceClient();
  const { data: agents } = await supabase
    .from("agents")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<{ id: string }[]>();

  if (!agents?.length) return [];

  const results: PollResult[] = [];
  for (const agent of agents) {
    results.push(await pollAgent(agent.id, options));
  }
  return results;
}
