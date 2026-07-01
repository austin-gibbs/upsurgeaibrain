// =====================================================================
// Queue definitions + job payload types.
//
//  poll  — one job per agent per 2-minute bucket during the call window: scans
//          the CRM and enqueues calls.
//  call  — one job per dial. Drip throttle is enforced with per-job delay
//          so dials for an agent are spaced `drip_seconds` apart.
// =====================================================================
import { Queue } from "bullmq";
import { closeRedis, getRedis } from "./connection";

export const POLL_QUEUE = "agent-poll";
export const CALL_QUEUE = "outbound-call";

export interface PollJob {
  agentId: string;
  testMode?: boolean;
}

export interface CallJob {
  agentId: string;
  contactId: string;
  toNumber: string;
  attemptNumber: number;
  /** Zero-based phone index within this cadence attempt. */
  phoneIndex?: number;
  /** Total phones in this attempt snapshot. */
  phoneCount?: number;
  /** Durable queue row driving this dial. */
  queueEntryId?: string;
  /** Workspace-local queue day (YYYY-MM-DD). */
  queueDay?: string;
  testMode?: boolean;
}

let pollQueue: Queue<PollJob> | null = null;
let callQueue: Queue<CallJob> | null = null;

export function getPollQueue(): Queue<PollJob> {
  if (!pollQueue) {
    pollQueue = new Queue<PollJob>(POLL_QUEUE, { connection: getRedis() });
  }
  return pollQueue;
}

export function getCallQueue(): Queue<CallJob> {
  if (!callQueue) {
    callQueue = new Queue<CallJob>(CALL_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return callQueue;
}

export interface CallJobSpec {
  data: CallJob;
  delay: number;
  jobId: string;
}

/** One Redis round-trip for many delayed dial jobs (serverless-safe). */
export async function addCallJobsBulk(specs: CallJobSpec[]): Promise<void> {
  if (specs.length === 0) return;
  const queue = getCallQueue();
  const redis = getRedis();
  await redis.connect();

  // Replace any stale jobs with the same id (e.g. operator re-queues).
  for (const spec of specs) {
    const existing = await queue.getJob(spec.jobId);
    if (existing) await existing.remove().catch(() => {});
  }

  await queue.addBulk(
    specs.map((s) => ({
      name: "dial",
      data: s.data,
      opts: { delay: s.delay, jobId: s.jobId },
    }))
  );
}

/** Release queue + Redis after a short-lived API enqueue. */
export async function closeCallQueue(): Promise<void> {
  if (callQueue) {
    await callQueue.close();
    callQueue = null;
  }
  closeRedis();
}

/**
 * Best-effort removal of BullMQ dial jobs by deterministic job id.
 * Postgres queue cleanup is authoritative; Redis removal is supplementary.
 */
export async function removeCallJobsByIds(jobIds: string[]): Promise<number> {
  if (jobIds.length === 0 || !process.env.REDIS_URL) return 0;

  const queue = getCallQueue();
  let removed = 0;
  for (const jobId of jobIds) {
    const existing = await queue.getJob(jobId);
    if (!existing) continue;
    try {
      await existing.remove();
      removed++;
    } catch {
      // Job may have started running between lookup and removal.
    }
  }
  return removed;
}
