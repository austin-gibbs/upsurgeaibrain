import { createServiceClient } from "@/lib/supabase/server";
import { getCallQueue, removeCallJobsByIds, type CallJob } from "@/lib/queue/queues";
import {
  getQueueEntryById,
  revertQueueForNextPhone,
} from "./call-queue";
import {
  bullmqJobIdForPhone,
  chainedPhoneJobIds,
  shouldContinueToNextPhone,
} from "./multi-phone";
import type { CallOutcome } from "@/types";

/** Enqueue the next phone in a multi-number FUB attempt after a no-answer/error. */
export async function chainNextPhoneDial(params: {
  queueEntryId: string;
  outcome: CallOutcome;
  phoneIndex: number;
  phoneCount: number;
  dripSeconds: number;
}): Promise<boolean> {
  if (
    !shouldContinueToNextPhone(
      params.outcome,
      params.phoneIndex,
      params.phoneCount
    )
  ) {
    return false;
  }

  const supabase = createServiceClient();
  const entry = await getQueueEntryById(supabase, params.queueEntryId);
  if (!entry) return false;

  const nextPhoneIndex = params.phoneIndex + 1;
  const baseJobId =
    entry.bullmq_job_id?.replace(/[:-]p\d+$/, "") ??
    `${entry.agent_id}-${entry.contact_id}-${entry.queue_day}`;
  const nextJobId = bullmqJobIdForPhone(baseJobId, nextPhoneIndex);
  const delayMs = Math.max(params.dripSeconds, 1) * 1000;
  const scheduledFor = new Date(Date.now() + delayMs).toISOString();
  const toNumber = entry.phone_numbers[nextPhoneIndex];
  if (!toNumber) return false;

  const job: CallJob = {
    agentId: entry.agent_id,
    contactId: entry.contact_id,
    toNumber,
    attemptNumber: entry.attempt_number,
    phoneIndex: nextPhoneIndex,
    phoneCount: entry.phone_numbers.length,
    queueEntryId: entry.id,
    queueDay: entry.queue_day,
  };

  await revertQueueForNextPhone(supabase, {
    id: entry.id,
    nextPhoneIndex,
    scheduledFor,
    bullmqJobId: nextJobId,
  });

  if (process.env.REDIS_URL) {
    const queue = getCallQueue();
    const existing = await queue.getJob(nextJobId);
    if (existing) await existing.remove().catch(() => {});
    await queue.add("dial", job, { delay: delayMs, jobId: nextJobId });
  }

  return true;
}

/** Remove any not-yet-run chained phone jobs when an attempt ends early. */
export async function cancelRemainingChainedPhoneJobs(params: {
  baseJobId: string;
  phoneIndex: number;
  phoneCount: number;
}): Promise<number> {
  const jobIds = chainedPhoneJobIds(
    params.baseJobId,
    params.phoneIndex,
    params.phoneCount
  );
  if (!jobIds.length || !process.env.REDIS_URL) return 0;
  return removeCallJobsByIds(jobIds);
}
