// Worker that consumes `post-call-automation` jobs and fires ONE automation
// run (config-driven post-call trigger action). Fully additive: it only touches
// the automation tables + the configured outbound webhook. Its own queue means
// automation delivery never steals capacity from voice dials.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { AUTOMATION_QUEUE, type AutomationJob } from "../queues";
import {
  executeAutomationRun,
  AutomationRetryableError,
} from "@/lib/engine/automations/execute";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const CONCURRENCY = intEnv("AUTOMATION_WORKER_CONCURRENCY", 10);
const RATE_MAX = intEnv("AUTOMATION_WORKER_RATE_MAX", 20);
const RATE_DURATION_MS = intEnv("AUTOMATION_WORKER_RATE_DURATION_MS", 1000);

export function startAutomationWorker(): Worker<AutomationJob> {
  const worker = new Worker<AutomationJob>(
    AUTOMATION_QUEUE,
    async (job) => {
      try {
        return await executeAutomationRun(job.data.runId);
      } catch (err) {
        // Retryable → rethrow so BullMQ backoff re-runs this same runId. The
        // run row already recorded status='failed' + last_error. When the run's
        // own max_attempts is hit, executeAutomationRun marks it 'dead' and
        // returns without throwing (no further retries).
        if (err instanceof AutomationRetryableError) throw err;
        // Unexpected error: log and swallow so one bad job can't wedge the queue.
        console.error(`[automation.worker] job ${job.id} error:`, err);
        return { ok: false, status: "failed" as const };
      }
    },
    {
      connection: getRedis(),
      concurrency: CONCURRENCY,
      limiter: { max: RATE_MAX, duration: RATE_DURATION_MS },
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[automation.worker] job ${job?.id} failed:`, err.message);
  });
  worker.on("completed", (job, result) => {
    const r = result as { status?: string };
    if (r?.status === "sent") console.log(`[automation.worker] run ${job.data.runId} sent`);
  });

  return worker;
}
