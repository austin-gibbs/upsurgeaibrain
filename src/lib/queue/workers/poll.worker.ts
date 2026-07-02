// Worker that consumes `agent-poll` jobs and scans/enqueues for one agent.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { POLL_QUEUE, type PollJob } from "../queues";
import { pollAgent } from "@/lib/engine/poller";
import { writePollWorkerLiveness } from "@/lib/engine/heartbeat";

export function startPollWorker(): Worker<PollJob> {
  const worker = new Worker<PollJob>(
    POLL_QUEUE,
    async (job) => {
      await writePollWorkerLiveness().catch((err) => {
        console.error("[poll.worker] liveness write failed:", err);
      });
      const result = await pollAgent(job.data.agentId, {
        testMode: job.data.testMode,
        triggerSource: "worker",
      });
      console.log(`[poll.worker] agent ${job.data.agentId}:`, result);
      return result;
    },
    { connection: getRedis(), concurrency: 2 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[poll.worker] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
