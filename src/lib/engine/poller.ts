// =====================================================================
// Poller — the n8n "Call Initiator (WF1)" replacement.
//
// For one agent: pull enrolled contacts from the CRM, reconcile them into
// our `contacts` cache, filter for eligibility, and enqueue one `call` job
// per eligible contact with a drip-throttle delay so dials are spaced out.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapter } from "@/lib/crm";
import { getCallQueue } from "@/lib/queue/queues";
import { isEligible, todayInTz, withinCallWindow } from "./cadence";
import type { Agent, AgentCallConfig, Contact, Workspace } from "@/types";

export interface PollResult {
  agentId: string;
  scanned: number;
  eligible: number;
  enqueued: number;
  skippedReason?: string;
}

export async function pollAgent(agentId: string): Promise<PollResult> {
  const supabase = createServiceClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single<Agent>();
  if (!agent) return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "agent not found" };
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

  if (!withinCallWindow(workspace.timezone, config.call_window_start, config.call_window_end)) {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "outside call window" };
  }

  const today = todayInTz(workspace.timezone);
  const crm = getCrmAdapter(workspace);

  // 1. Pull everyone carrying the enroll tag.
  const crmContacts = await crm.getContactsByTag(workspace.enroll_tag);

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

  // 3. Filter eligible + respect the daily cap.
  const eligible = contacts.filter((c) => isEligible(c, config, today) && c.phones.length > 0);
  const capped = eligible.slice(0, config.max_calls_per_day);

  // 4. Enqueue with drip throttle (delay = index * drip_seconds).
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
      },
      {
        delay: i * config.drip_seconds * 1000,
        jobId: `${agentId}:${contact.id}:${today}`, // idempotent per day
      }
    );
    enqueued++;
  }

  return { agentId, scanned: contacts.length, eligible: eligible.length, enqueued };
}
