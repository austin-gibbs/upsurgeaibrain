// Worker that consumes `agent-poll` jobs and scans/enqueues for one agent.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { POLL_QUEUE, type PollJob } from "../queues";
import { pollAgent } from "@/lib/engine/poller";

export function startPollWorker(): Worker<PollJob> {
  const worker = new Worker<PollJob>(
    POLL_QUEUE,
    async (job) => {
      const result = await pollAgent(job.data.agentId);
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
