// Re-align pending outbound-call jobs when an agent's call window or drip
// settings change. Removes queued jobs and re-enqueues them with fresh delays
// anchored to the updated window.
import { createServiceClient } from "@/lib/supabase/server";
import { msUntilQueueSlot, todayInTz } from "@/lib/engine/cadence";
import { upsertQueueEntry } from "@/lib/engine/call-queue";
import { getCallQueue, type CallJob } from "./queues";
import type { AgentCallConfig } from "@/types";

/**
 * Reschedule all pending dial jobs for an agent using the agent's current
 * call_config. Returns the number of jobs re-enqueued.
 */
export async function rescheduleAgentCallQueue(agentId: string): Promise<number> {
  if (!process.env.REDIS_URL) return 0;

  const supabase = createServiceClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("workspace_id, direction")
    .eq("id", agentId)
    .single<{ workspace_id: string; direction: string }>();
  if (!agent || agent.direction !== "outbound") return 0;

  const { data: config } = await supabase
    .from("agent_call_configs")
    .select("*")
    .eq("agent_id", agentId)
    .single<AgentCallConfig>();
  if (!config) return 0;

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("timezone")
    .eq("id", agent.workspace_id)
    .single<{ timezone: string }>();
  const timezone = workspace?.timezone ?? "America/New_York";
  const today = todayInTz(timezone);

  const queue = getCallQueue();
  const jobs = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"]);

  const agentJobs = jobs.filter(
    (job) => job?.data?.agentId === agentId && !job.data.testMode
  );
  if (agentJobs.length === 0) return 0;

  // Keep one job per contact — prefer the soonest scheduled slot.
  const byContact = new Map<string, { data: CallJob; sortKey: number }>();
  for (const job of agentJobs) {
    const data = job.data as CallJob;
    const delay = job.opts.delay ?? 0;
    const sortKey = (job.timestamp ?? 0) + delay;
    const existing = byContact.get(data.contactId);
    if (!existing || sortKey < existing.sortKey) {
      byContact.set(data.contactId, { data, sortKey });
    }
  }

  for (const job of agentJobs) {
    try {
      await job.remove();
    } catch {
      // Job may have started between scan and removal.
    }
  }

  const pending = [...byContact.values()].sort((a, b) => a.sortKey - b.sortKey);

  let rescheduled = 0;
  for (let i = 0; i < pending.length; i++) {
    const job = pending[i].data;
    const delay = msUntilQueueSlot(
      timezone,
      config.call_window_start,
      config.call_window_end,
      config.drip_seconds,
      i,
      config.call_window_days
    );
    const safeDelay = Math.max(delay, 0);
    const scheduledFor = new Date(Date.now() + safeDelay).toISOString();
    const jobId = `${agentId}:${job.contactId}:${today}`;

    const { data: queueRow } = await supabase
      .from("call_queue_entries")
      .select("attempt_number, phone_numbers, next_phone_index")
      .eq("agent_id", agentId)
      .eq("contact_id", job.contactId)
      .eq("queue_day", today)
      .maybeSingle<{
        attempt_number: number;
        phone_numbers: string[];
        next_phone_index: number;
      }>();

    await upsertQueueEntry(supabase, {
      workspaceId: agent.workspace_id,
      agentId,
      contactId: job.contactId,
      queueDay: today,
      position: i + 1,
      scheduledFor,
      bullmqJobId: jobId,
      attemptNumber: queueRow?.attempt_number ?? job.attemptNumber,
      phoneNumbers:
        queueRow?.phone_numbers?.length ? queueRow.phone_numbers : [job.toNumber],
      nextPhoneIndex: queueRow?.next_phone_index ?? job.phoneIndex ?? 0,
    });

    await queue.add("dial", job, {
      delay: safeDelay,
      jobId,
    });
    rescheduled++;
  }

  return rescheduled;
}
