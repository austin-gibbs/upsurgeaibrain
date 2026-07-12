// Worker that consumes `agent-poll` jobs and scans/enqueues for one agent.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { POLL_QUEUE, type PollJob } from "../queues";
import { pollAgent } from "@/lib/engine/poller";
import { writePollWorkerLiveness } from "@/lib/engine/heartbeat";

async function touchPollWorkerLiveness(reason: string): Promise<void> {
  await writePollWorkerLiveness().catch((err) => {
    console.error(`[poll.worker] liveness write failed (${reason}):`, err);
  });
}

export function startPollWorker(): Worker<PollJob> {
  const worker = new Worker<PollJob>(
    POLL_QUEUE,
    async (job) => {
      await touchPollWorkerLiveness("job");
      const result = await pollAgent(job.data.agentId, {
        testMode: job.data.testMode,
        triggerSource: "worker",
      });
      console.log(`[poll.worker] agent ${job.data.agentId}:`, result);
      return result;
    },
    { connection: getRedis(), concurrency: 2 }
  );

  // Ready/startup liveness so poll_worker_last_seen_at is not null simply
  // because no poll job has been consumed yet (e.g. all agents off-day).
  void touchPollWorkerLiveness("startup");
  worker.on("ready", () => {
    void touchPollWorkerLiveness("ready");
  });

  worker.on("failed", (job, err) => {
    console.error(`[poll.worker] job ${job?.id} failed:`, err.message);
  });

  return worker;
}
