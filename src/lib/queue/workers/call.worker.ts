// Worker that consumes `outbound-call` jobs and places the call.
import { Worker } from "bullmq";
import { getRedis } from "../connection";
import { CALL_QUEUE, getCallQueue, type CallJob } from "../queues";
import { placeCall, OutsideCallWindowError } from "@/lib/engine/caller";
import { failQueueEntry, updateQueueScheduledFor } from "@/lib/engine/call-queue";
import { evaluateDialWindow } from "@/lib/engine/cadence";
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

/** Positive integer env override with a safe fallback. */
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Tunable against the Retell plan's concurrent-call + create-rate caps without a
// code change. Defaults match the previously hard-coded values.
const CALL_CONCURRENCY = intEnv("CALL_WORKER_CONCURRENCY", 20);
const CALL_RATE_MAX = intEnv("CALL_WORKER_RATE_MAX", 20);
const CALL_RATE_DURATION_MS = intEnv("CALL_WORKER_RATE_DURATION_MS", 1000);

async function deferDial(job: CallJob, delayMs: number, reason: string) {
  const delay = Math.max(delayMs, 60_000);
  const scheduledFor = new Date(Date.now() + delay).toISOString();

  await getCallQueue().add("dial", job, {
    delay,
    jobId: `defer:${job.agentId}:${job.contactId}`,
  });

  const supabase = createServiceClient();
  await updateQueueScheduledFor(supabase, {
    agentId: job.agentId,
    contactId: job.contactId,
    scheduledFor,
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
      // Fast pre-check: a job can become ready outside the window via drip
      // spillover or retry backoff. When that happens, re-queue it to fire when
      // the window next opens instead of placing the call now. The deterministic
      // jobId keeps at most one pending deferral per contact. This is an
      // optimization — the AUTHORITATIVE guard lives inside placeCall (it throws
      // OutsideCallWindowError), caught below, so the window holds even if this
      // pre-check is ever skipped or the clock crosses the boundary after it.
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

        const decision = evaluateDialWindow(
          timezone,
          config?.call_window_start,
          config?.call_window_end
        );
        if (!decision.allowed) {
          return deferDial(job.data, decision.deferMs, decision.reason);
        }
      }

      try {
        return await placeCall(job.data);
      } catch (err) {
        // placeCall refuses to dial outside the window (defense in depth). Treat
        // that as a deferral, not a failure, so the contact is never dropped.
        if (err instanceof OutsideCallWindowError) {
          return deferDial(job.data, err.deferMs, err.reason);
        }
        throw err;
      }
    },
    {
      connection: getRedis(),
      concurrency: CALL_CONCURRENCY,
      // Retell create-phone-call cap: never exceed CALL_RATE_MAX dials per
      // CALL_RATE_DURATION_MS across the whole queue. Excess jobs wait
      // (Redis-backed limiter) until a slot frees — even if many triggers
      // arrive at once. Tune via env to match the Retell account's caps.
      limiter: { max: CALL_RATE_MAX, duration: CALL_RATE_DURATION_MS },
    }
  );

  worker.on("failed", async (job, err) => {
    console.error(`[call.worker] job ${job?.id} failed:`, err.message);
    // On final attempt, mark any orphaned call row failed.
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      try {
        const supabase = createServiceClient();
        await supabase
          .from("calls")
          .update({ status: "failed", error_message: err.message })
          .eq("agent_id", job.data.agentId)
          .eq("contact_id", job.data.contactId)
          .eq("status", "queued");
        await failQueueEntry(supabase, {
          agentId: job.data.agentId,
          contactId: job.data.contactId,
          errorMessage: err.message,
        });
      } catch (cleanupErr) {
        console.error(
          `[call.worker] failed-job cleanup error for ${job.id}:`,
          cleanupErr instanceof Error ? cleanupErr.message : cleanupErr
        );
      }
    }
  });

  worker.on("completed", (job, result) => {
    if (result && (result as { deferred?: boolean }).deferred) return;
    console.log(`[call.worker] dialed contact ${job.data.contactId}`);
  });

  return worker;
}
