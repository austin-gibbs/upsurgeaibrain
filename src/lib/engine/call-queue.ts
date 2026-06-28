// Durable call queue — tracks contacts from BullMQ enqueue through FUB writeback.
import { createServiceClient } from "@/lib/supabase/server";
import { addDays, todayInTz, zonedDateTimeToUtcIso } from "./cadence";
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

export interface ClaimedQueueEntry {
  id: string;
  agent_id: string;
  contact_id: string;
  workspace_id: string;
  queue_day: string;
  position: number;
  scheduled_for: string | null;
  bullmq_job_id: string | null;
}

/** Look up today's pending queue row for a contact dial job. */
export async function findPendingQueueEntry(
  supabase: DbClient,
  params: { agentId: string; contactId: string; queueDay: string }
): Promise<{ id: string } | null> {
  const { data, error } = await supabase
    .from("call_queue_entries")
    .select("id")
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .eq("queue_day", params.queueDay)
    .eq("status", "pending")
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Resolve and atomically claim the pending queue row for a dial job.
 * Returns null when no pending row exists or another executor claimed it first.
 */
export async function claimQueueEntryForDial(
  supabase: DbClient,
  params: { agentId: string; contactId: string; queueDay: string }
): Promise<ClaimedQueueEntry | null> {
  const pending = await findPendingQueueEntry(supabase, params);
  if (!pending) return null;
  return claimQueueEntry(supabase, { id: pending.id });
}

/**
 * Atomically move a pending row to `dialing` before placing a call.
 * Returns null when another executor already claimed the row.
 */
export async function claimQueueEntry(
  supabase: DbClient,
  params: { id: string }
): Promise<ClaimedQueueEntry | null> {
  const { data, error } = await supabase
    .from("call_queue_entries")
    .update({
      status: "dialing",
      started_at: new Date().toISOString(),
    })
    .eq("id", params.id)
    .eq("status", "pending")
    .select(
      "id, agent_id, contact_id, workspace_id, queue_day, position, scheduled_for, bullmq_job_id"
    )
    .maybeSingle<ClaimedQueueEntry>();

  if (error) throw new Error(error.message);
  return data;
}

/** Revert a claim when dialing is deferred (e.g. outside call window). */
export async function revertQueueClaim(
  supabase: DbClient,
  params: { id: string; scheduledFor?: string }
): Promise<void> {
  const patch: {
    status: "pending";
    started_at: null;
    call_id: null;
    scheduled_for?: string;
  } = {
    status: "pending",
    started_at: null,
    call_id: null,
  };
  if (params.scheduledFor) patch.scheduled_for = params.scheduledFor;

  const { error } = await supabase
    .from("call_queue_entries")
    .update(patch)
    .eq("id", params.id)
    .eq("status", "dialing");
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

/** Pending + dialing rows from prior calendar days — rollover backlog. */
export async function countRolloverBacklogForAgent(
  supabase: DbClient,
  agentId: string,
  today: string
): Promise<number> {
  const { count, error } = await supabase
    .from("call_queue_entries")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .lt("queue_day", today)
    .in("status", ["pending", "dialing"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Contact IDs with any active queue row for this agent (all queue days). */
export async function listActiveQueuedContactIdsForAgent(
  supabase: DbClient,
  agentId: string
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("call_queue_entries")
    .select("contact_id")
    .eq("agent_id", agentId)
    .in("status", ["pending", "dialing"])
    .returns<{ contact_id: string }[]>();
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.contact_id));
}

/** Calls already placed today for an agent (workspace-local calendar day). */
export async function countDialedTodayForAgent(
  supabase: DbClient,
  agentId: string,
  timezone: string
): Promise<number> {
  const today = todayInTz(timezone);
  const tomorrow = addDays(today, 1);
  const dayStart = zonedDateTimeToUtcIso(timezone, today, "00:00");
  const dayEnd = zonedDateTimeToUtcIso(timezone, tomorrow, "00:00");
  const { count, error } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentId)
    .not("dialed_at", "is", null)
    .gte("dialed_at", dayStart)
    .lt("dialed_at", dayEnd);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Renumber rollover rows to positions 1..N (oldest queue_day first) for Ops
 * visibility. Does not touch today's or future rows.
 */
export async function normalizeRolloverPositions(
  supabase: DbClient,
  agentId: string,
  today: string
): Promise<number> {
  const { data, error } = await supabase
    .from("call_queue_entries")
    .select("id, queue_day, position, enqueued_at")
    .eq("agent_id", agentId)
    .lt("queue_day", today)
    .eq("status", "pending")
    .order("queue_day", { ascending: true })
    .order("position", { ascending: true })
    .order("enqueued_at", { ascending: true })
    .returns<{ id: string; queue_day: string; position: number; enqueued_at: string }[]>();
  if (error) throw new Error(error.message);
  if (!data?.length) return 0;

  let updated = 0;
  for (let i = 0; i < data.length; i++) {
    const target = i + 1;
    if (data[i].position === target) continue;
    const { error: patchErr } = await supabase
      .from("call_queue_entries")
      .update({ position: target })
      .eq("id", data[i].id);
    if (patchErr) throw new Error(patchErr.message);
    updated++;
  }
  return updated;
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
