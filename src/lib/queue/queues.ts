// =====================================================================
// Queue definitions + job payload types.
//
//  poll  — one job per agent per day: scans the CRM and enqueues calls.
//  call  — one job per dial. Drip throttle is enforced with per-job delay
//          so dials for an agent are spaced `drip_seconds` apart.
// =====================================================================
import { Queue } from "bullmq";
import { getRedis } from "./connection";

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
