// Worker that consumes `outbound-call` jobs and places the call.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { CALL_QUEUE, getCallQueue, type CallJob } from "../queues";
import { placeCall } from "@/lib/engine/caller";
import {
  withinCallWindow,
  withinEasternBusinessHours,
  msUntilEasternWindowOpens,
  msUntilCallWindowOpens,
} from "@/lib/engine/cadence";
import { createServiceClient } from "@/lib/supabase/server";

type AgentWindowRow = {
  agent_call_configs: {
    call_window_start: string;
    call_window_end: string;
  } | {
    call_window_start: string;
    call_window_end: string;
  }[] | null;
  workspaces: { timezone: string } | null;
};

async function deferDial(job: CallJob, delayMs: number, reason: string) {
  const delay = Math.max(delayMs, 60_000);
  await getCallQueue().add("dial", job, {
    delay,
    jobId: `defer:${job.agentId}:${job.contactId}`,
  });
  console.log(
    `[call.worker] ${reason} — deferred contact ${job.contactId} ~${Math.round(delay / 60000)}m`
  );
  return { deferred: true };
}

export function startCallWorker(): Worker<CallJob> {
  const worker = new Worker<CallJob>(
    CALL_QUEUE,
    async (job) => {
      // Hard business-hours guard: never dial outside 9am–7pm Eastern. A job
      // can become ready outside the window via drip spillover or retry
      // backoff — when that happens, re-queue it to fire when the window next
      // opens instead of placing the call now. The deterministic jobId keeps
      // at most one pending deferral per contact.
      if (!job.data.testMode && !withinEasternBusinessHours()) {
        const delay = Math.max(msUntilEasternWindowOpens(), 60_000);
        return deferDial(job.data, delay, "outside 9am-7pm ET");
      }

      if (!job.data.testMode) {
        const supabase = createServiceClient();
        const { data: agentRow } = await supabase
          .from("agents")
          .select(
            "agent_call_configs(call_window_start, call_window_end), workspaces(timezone)"
          )
          .eq("id", job.data.agentId)
          .single<AgentWindowRow>();

        const config = Array.isArray(agentRow?.agent_call_configs)
          ? agentRow.agent_call_configs[0]
          : agentRow?.agent_call_configs;
        const timezone = agentRow?.workspaces?.timezone ?? "America/New_York";

        if (
          config &&
          !withinCallWindow(
            timezone,
            config.call_window_start,
            config.call_window_end
          )
        ) {
          const delay = msUntilCallWindowOpens(
            timezone,
            config.call_window_start,
            config.call_window_end
          );
          return deferDial(
            job.data,
            delay,
            `outside agent window ${config.call_window_start}-${config.call_window_end} ${timezone}`
          );
        }
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
