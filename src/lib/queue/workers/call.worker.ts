// Worker that consumes `outbound-call` jobs and places the call.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { CALL_QUEUE, getCallQueue, type CallJob } from "../queues";
import { placeCall } from "@/lib/engine/caller";
import { withinEasternBusinessHours, msUntilEasternWindowOpens } from "@/lib/engine/cadence";
import { createServiceClient } from "@/lib/supabase/server";

export function startCallWorker(): Worker<CallJob> {
  const worker = new Worker<CallJob>(
    CALL_QUEUE,
    async (job) => {
      // Hard business-hours guard: never dial outside 9am–7pm Eastern. A job
      // can become ready outside the window via drip spillover or retry
      // backoff — when that happens, re-queue it to fire when the window next
      // opens instead of placing the call now. The deterministic jobId keeps
      // at most one pending deferral per contact.
      if (!withinEasternBusinessHours()) {
        const delay = Math.max(msUntilEasternWindowOpens(), 60_000);
        await getCallQueue().add("dial", job.data, {
          delay,
          jobId: `defer:${job.data.agentId}:${job.data.contactId}`,
        });
        console.log(
          `[call.worker] outside 9am-7pm ET — deferred contact ${job.data.contactId} ~${Math.round(delay / 60000)}m`
        );
        return { deferred: true };
      }
      const result = await placeCall(job.data);
      return result;
    },
    {
      connection: getRedis(),
      concurrency: 20,
      // Retell create-phone-call cap: never exceed 20 dials per second across
      // the whole queue. Excess jobs wait (Redis-backed limiter) until a slot
      // frees — even if many triggers arrive at once.
      limiter: { max: 20, duration: 1000 },
    }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[call.worker] job ${job?.id} failed:`, err.message);
    // On final attempt, mark any orphaned call row failed.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      const supabase = createServiceClient();
      await supabase
        .from("calls")
        .update({ status: "failed", error_message: err.message })
        .eq("contact_id", job.data.contactId)
        .eq("status", "queued");
    }
  });

  worker.on("completed", (job, result) => {
    if (result && (result as { deferred?: boolean }).deferred) return;
    console.log(`[call.worker] dialed contact ${job.data.contactId}`);
  });

  return worker;
}
