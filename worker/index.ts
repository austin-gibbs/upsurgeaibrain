// =====================================================================
// Worker process entrypoint.  Run alongside the Next.js app:
//
//   npm run worker        (dev, watches for changes)
//   npm run worker:prod   (production)
//
// Starts the BullMQ workers (poll + call) and a 60s scheduler tick that
// enqueues daily polls. This is the always-on backend that replaces n8n.
// =====================================================================
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { startPollWorker } from "@/lib/queue/workers/poll.worker";
import { startCallWorker } from "@/lib/queue/workers/call.worker";
import { tickScheduler } from "@/lib/engine/scheduler";
import { reconcileStuckCalls } from "@/lib/engine/reconcile";

async function main() {
  console.log("[worker] starting Upsurge engine…");

  const pollWorker = startPollWorker();
  const callWorker = startCallWorker();

  // Internal scheduler: tick every minute. (Disable and use external cron
  // instead by setting USE_EXTERNAL_CRON=true.)
  let timer: NodeJS.Timeout | null = null;
  if (process.env.USE_EXTERNAL_CRON !== "true") {
    timer = setInterval(async () => {
      try {
        const { enqueued } = await tickScheduler();
        if (enqueued.length) console.log("[scheduler] enqueued polls:", enqueued);
      } catch (e) {
        console.error("[scheduler] tick error:", e);
      }
    }, 60_000);
  }

  // Self-heal sweep: every 2 minutes, finalize calls stuck in `dialing`
  // whose outcome webhook never landed (e.g. a signature mismatch). Only
  // touches calls dialed at least 2 minutes ago so in-flight calls are safe.
  // Bounded and idempotent — reconciled calls leave `dialing` and won't be
  // re-picked, so steady-state cost is ~0 when the webhook path is healthy.
  let reconcileTimer: NodeJS.Timeout | null = setInterval(async () => {
    try {
      const summary = await reconcileStuckCalls({ olderThanMinutes: 2, limit: 50 });
      if (summary.reconciled || summary.failed) {
        console.log("[reconcile] stuck-call sweep:", summary);
      }
    } catch (e) {
      console.error("[reconcile] sweep error:", e);
    }
  }, 2 * 60_000);

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    if (timer) clearInterval(timer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    await Promise.all([pollWorker.close(), callWorker.close()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[worker] ready. Poll + call workers online.");
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
