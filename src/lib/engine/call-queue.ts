// Durable call queue — tracks contacts from BullMQ enqueue through FUB writeback.
import { createServiceClient } from "@/lib/supabase/server";
import type { CallQueueStatus } from "@/types";

type DbClient = ReturnType<typeof createServiceClient>;

export interface EnqueueQueueEntryInput {
  workspaceId: string;
  agentId: string;
  contactId: string;
  queueDay: string;
  position: number;
  scheduledFor: string | null;
  bullmqJobId: string;
}

/** Insert or refresh a queue row when a dial job is enqueued. */
export async function upsertQueueEntry(
  supabase: DbClient,
  input: EnqueueQueueEntryInput
): Promise<void> {
  const { data: existing, error: fetchErr } = await supabase
    .from("call_queue_entries")
    .select("id, status")
    .eq("agent_id", input.agentId)
    .eq("contact_id", input.contactId)
    .eq("queue_day", input.queueDay)
    .maybeSingle<{ id: string; status: CallQueueStatus }>();

  if (fetchErr) throw new Error(fetchErr.message);

  if (
    existing &&
    (existing.status === "pending" || existing.status === "dialing")
  ) {
    const { error } = await supabase
      .from("call_queue_entries")
      .update({
        position: input.position,
        scheduled_for: input.scheduledFor,
        bullmq_job_id: input.bullmqJobId,
      })
      .eq("id", existing.id);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from("call_queue_entries").upsert(
    {
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      contact_id: input.contactId,
      queue_day: input.queueDay,
      status: "pending",
      position: input.position,
      scheduled_for: input.scheduledFor,
      bullmq_job_id: input.bullmqJobId,
      enqueued_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      call_id: null,
      error_message: null,
    },
    { onConflict: "agent_id,contact_id,queue_day" }
  );
  if (error) throw new Error(error.message);
}

/** Mark the queue entry as actively dialing once Retell accepts the call. */
export async function markQueueDialing(
  supabase: DbClient,
  params: { agentId: string; contactId: string; callId: string; queueDay?: string }
): Promise<void> {
  let query = supabase
    .from("call_queue_entries")
    .update({
      status: "dialing",
      call_id: params.callId,
      started_at: new Date().toISOString(),
    })
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .in("status", ["pending", "dialing"]);

  if (params.queueDay) query = query.eq("queue_day", params.queueDay);

  await query;
}

/** Remove the contact from the active queue after FUB writeback completes. */
export async function completeQueueEntry(
  supabase: DbClient,
  params: { callId: string }
): Promise<void> {
  await supabase
    .from("call_queue_entries")
    .delete()
    .eq("call_id", params.callId);
}

/** Drop queue membership when a dial job permanently fails. */
export async function failQueueEntry(
  supabase: DbClient,
  params: { agentId: string; contactId: string; errorMessage: string }
): Promise<void> {
  await supabase
    .from("call_queue_entries")
    .delete()
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .in("status", ["pending", "dialing"]);
}

/** Cancel pending queue rows when a manual call-now supersedes scheduled dials. */
export async function cancelQueueEntries(
  supabase: DbClient,
  params: { agentId: string; contactId: string }
): Promise<void> {
  await supabase
    .from("call_queue_entries")
    .delete()
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .eq("status", "pending");
}

export interface ActiveQueueRow {
  id: string;
  agent_id: string;
  contact_id: string;
  status: CallQueueStatus;
  position: number;
  scheduled_for: string | null;
  enqueued_at: string;
  started_at: string | null;
  call_id: string | null;
  contacts: { full_name: string | null; phones: string[] } | null;
  agents: { name: string } | null;
}

/** Count pending + dialing rows for an agent today (for queue position offset). */
export async function countActiveQueueForAgent(
  supabase: DbClient,
  agentId: string,
  queueDay: string
): Promise<number> {
  const { count } = await supabase
    .from("call_queue_entries")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .eq("queue_day", queueDay)
    .in("status", ["pending", "dialing"]);
  return count ?? 0;
}

/** Update scheduled_for on a pending queue row (e.g. after defer or reschedule). */
export async function updateQueueScheduledFor(
  supabase: DbClient,
  params: { agentId: string; contactId: string; scheduledFor: string }
): Promise<void> {
  await supabase
    .from("call_queue_entries")
    .update({ scheduled_for: params.scheduledFor })
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .eq("status", "pending");
}

/** Active queue rows for the Ops UI (pending + dialing only). */
export async function listActiveQueueEntries(
  supabase: DbClient,
  workspaceId: string
): Promise<ActiveQueueRow[]> {
  const { data } = await supabase
    .from("call_queue_entries")
    .select(
      "id, agent_id, contact_id, status, position, scheduled_for, enqueued_at, started_at, call_id, contacts(full_name, phones), agents(name)"
    )
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "dialing"])
    .order("position", { ascending: true })
    .order("enqueued_at", { ascending: true })
    .returns<ActiveQueueRow[]>();

  return data ?? [];
}
