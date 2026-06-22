// =====================================================================
// Caller — places a single outbound call.
//
// Runs in the call worker. Loads agent + contact + memory, injects V2
// dynamic variables, creates the Retell call, writes a `calls` row in
// `dialing` status, marks the contact dialed in the CRM, and stamps the
// attempt. Outcome processing happens later via the Retell webhook.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapter } from "@/lib/crm";
import { RetellClient } from "@/lib/retell/client";
import { buildDynamicVariables } from "./memory";
import { todayInTz } from "./cadence";
import type { CallJob } from "@/lib/queue/queues";
import type { Agent, AgentMemory, Contact, Workspace } from "@/types";

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
  if (contact.is_terminal) {
    throw new Error(`contact ${job.contactId} is terminal — skipping`);
  }

  const { data: workspace } = await supabase
    .from("workspaces").select("*").eq("id", agent.workspace_id).single<Workspace>();
  if (!workspace) throw new Error(`workspace ${agent.workspace_id} not found`);

  const { data: memory } = await supabase
    .from("agent_memory").select("*")
    .eq("agent_id", job.agentId).eq("contact_id", job.contactId)
    .maybeSingle<AgentMemory>();

  // Record the call row first so the webhook can correlate even on a race.
  const { data: call } = await supabase
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
  if (!call) throw new Error("failed to create call row");

  // Inject V2 memory + identity into the Retell prompt.
  const dynamicVariables = buildDynamicVariables({
    agent,
    contact,
    memory: memory ?? null,
    attemptNumber: job.attemptNumber,
  });

  const retell = new RetellClient();
  const { callId: retellCallId } = await retell.createPhoneCall({
    fromNumber: agent.retell_from_number,
    toNumber: job.toNumber,
    agentId: agent.retell_agent_id,
    dynamicVariables,
    metadata: { call_id: call.id, workspace_id: workspace.id, agent_id: agent.id },
  });

  const today = todayInTz(workspace.timezone);

  await supabase
    .from("calls")
    .update({ retell_call_id: retellCallId, status: "dialing", dialed_at: new Date().toISOString() })
    .eq("id", call.id);

  // Stamp the attempt + mark dialed-today so the same-day filter excludes it.
  await supabase
    .from("contacts")
    .update({ attempt_count: job.attemptNumber, last_called_on: today })
    .eq("id", contact.id);

  // Best-effort CRM "dialed" marker (mirrors WF1's Mark Contact Dialed).
  try {
    const crm = getCrmAdapter(workspace);
    const dialedTag = `upsurgecalled${today.replace(/-/g, "")}`;
    if (!contact.tags.includes(dialedTag)) {
      await crm.setTags(contact.id, Array.from(new Set([...contact.tags, dialedTag])));
    }
  } catch {
    // non-fatal — the local last_called_on already guards same-day re-dials
  }

  return { callId: call.id, retellCallId };
}
