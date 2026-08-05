// =====================================================================
// Automation fallback drain — a safety net for the executor worker.
//
// The evaluate step enqueues a BullMQ job per run, but if Redis was down at
// enqueue time (row persisted 'queued', enqueue skipped) or a delayed-job set
// was wiped by a Redis restart, the run would sit forever. This sweep re-enqueues
// runs that are still 'queued' (or 'failed' under max_attempts) and due.
//
// Idempotent: enqueueAutomation uses a deterministic jobId (`automation-<runId>`)
// so re-enqueueing a run that already has a live job is a no-op.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { enqueueAutomation } from "@/lib/queue/queues";

export interface DrainSummary {
  reEnqueued: number;
  redisSkipped?: boolean;
}

export async function drainAutomationRuns(opts: { limit?: number } = {}): Promise<DrainSummary> {
  if (!process.env.REDIS_URL) return { reEnqueued: 0, redisSkipped: true };

  const limit = opts.limit ?? 500;
  const supabase = createServiceClient();
  const nowIso = new Date().toISOString();

  // Queued (never dispatched) or failed-but-retryable, and due.
  const { data: runs } = await supabase
    .from("automation_runs")
    .select("id, status, attempts, max_attempts")
    .in("status", ["queued", "failed"])
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (!runs || runs.length === 0) return { reEnqueued: 0 };

  let reEnqueued = 0;
  for (const run of runs) {
    if (run.status === "failed" && (run.attempts ?? 0) >= (run.max_attempts ?? 5)) continue;
    try {
      await enqueueAutomation({ runId: run.id });
      reEnqueued++;
    } catch {
      // Redis blip mid-drain — stop; the next sweep retries.
      return { reEnqueued, redisSkipped: true };
    }
  }
  return { reEnqueued };
}
