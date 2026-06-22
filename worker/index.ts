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

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    if (timer) clearInterval(timer);
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
