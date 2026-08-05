// =====================================================================
// Queue definitions + job payload types.
//
//  poll  — one job per agent per 30-second bucket during the call window: scans
//          the CRM and enqueues calls.
//  call  — one job per dial. Drip throttle is enforced with per-job delay
//          so dials for an agent are spaced `drip_seconds` apart.
// =====================================================================
import { Queue } from "bullmq";
import { closeRedis, getRedis } from "./connection";
import { sanitizeBullmqJobId } from "./job-id";

export const POLL_QUEUE = "agent-poll";
export const CALL_QUEUE = "outbound-call";
// SMS is a separate, additive channel — its own queue so it never contends
// with or affects the voice (call) pipeline.
export const SMS_QUEUE = "outbound-sms";
// Post-call automation executor — fires config-driven trigger actions
// (webhooks to HighLevel, internal notifies). Its own queue so automation
// throughput never contends with voice dials.
export const AUTOMATION_QUEUE = "post-call-automation";

export interface PollJob {
  agentId: string;
  testMode?: boolean;
}

export interface SmsJob {
  workspaceId: string;
  agentId: string;
  /** Internal contacts.id when known; inbound-triggered replies always have it. */
  contactId?: string;
  /** CRM-native contact id, for timeline logging. */
  crmContactId?: string;
  from: string; // E.164 agent number
  to: string; // E.164 lead number
  body: string;
  /** True when this send is a reply to an inbound text (quiet-hours exempt). */
  isReplyToInbound?: boolean;
  /** Pre-inserted sms_messages row to advance instead of inserting a new one. */
  messageRowId?: string;
  /** Who authored this outbound: the AI reply brain or a human operator. */
  sentBy?: "ai" | "human";
}

export interface AutomationJob {
  /** automation_runs.id to execute. The row holds the resolved request. */
  runId: string;
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
let smsQueue: Queue<SmsJob> | null = null;
let automationQueue: Queue<AutomationJob> | null = null;

export function getPollQueue(): Queue<PollJob> {
  if (!pollQueue) {
    pollQueue = new Queue<PollJob>(POLL_QUEUE, { connection: getRedis() });
  }
  return pollQueue;
}

export function getSmsQueue(): Queue<SmsJob> {
  if (!smsQueue) {
    smsQueue = new Queue<SmsJob>(SMS_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return smsQueue;
}

/** Enqueue one outbound SMS send. Optional delay for drip spacing. */
export async function enqueueSms(job: SmsJob, delayMs = 0): Promise<void> {
  const queue = getSmsQueue();
  await getRedis().connect();
  await queue.add("send-sms", job, { delay: delayMs });
}

export function getAutomationQueue(): Queue<AutomationJob> {
  if (!automationQueue) {
    automationQueue = new Queue<AutomationJob>(AUTOMATION_QUEUE, {
      connection: getRedis(),
      defaultJobOptions: {
        // The run row enforces max_attempts; give BullMQ generous retries so a
        // transient webhook 5xx/network blip backs off rather than dead-letters.
        attempts: 8,
        backoff: { type: "exponential", delay: 20_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return automationQueue;
}

/** Enqueue one automation run for the executor worker. */
export async function enqueueAutomation(job: AutomationJob, delayMs = 0): Promise<void> {
  const queue = getAutomationQueue();
  await getRedis().connect();
  await queue.add("execute-automation", job, {
    delay: delayMs,
    jobId: sanitizeBullmqJobId(`automation-${job.runId}`),
  });
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
    const jobId = sanitizeBullmqJobId(spec.jobId);
    const existing = await queue.getJob(jobId);
    if (existing) await existing.remove().catch(() => {});
  }

  await queue.addBulk(
    specs.map((s) => ({
      name: "dial",
      data: s.data,
      opts: { delay: s.delay, jobId: sanitizeBullmqJobId(s.jobId) },
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
    const existing = await queue.getJob(sanitizeBullmqJobId(jobId));
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
