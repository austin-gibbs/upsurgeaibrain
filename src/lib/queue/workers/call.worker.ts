// Worker that consumes `outbound-call` jobs and places the call.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { CALL_QUEUE, type CallJob } from "../queues";
import { placeCall } from "@/lib/engine/caller";
import { createServiceClient } from "@/lib/supabase/server";

export function startCallWorker(): Worker<CallJob> {
  const worker = new Worker<CallJob>(
    CALL_QUEUE,
    async (job) => {
      const result = await placeCall(job.data);
      return result;
    },
    { connection: getRedis(), concurrency: 5 }
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

  worker.on("completed", (job) => {
    console.log(`[call.worker] dialed contact ${job.data.contactId}`);
  });

  return worker;
}
