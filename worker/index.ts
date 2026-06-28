// =====================================================================
// Worker process entrypoint.  Run alongside the Next.js app:
//
//   npm run worker        (dev, watches for changes)
//   npm run worker:prod   (production)
//
// Starts the BullMQ workers (poll + call) and a 60s scheduler tick that
// enqueues daily polls. This is the always-on backend that replaces n8n.
// =====================================================================
process.env.UPSURGE_WORKER = "true";

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { createServer, type Server } from "node:http";
import { startPollWorker } from "@/lib/queue/workers/poll.worker";
import { startCallWorker } from "@/lib/queue/workers/call.worker";
import { tickScheduler } from "@/lib/engine/scheduler";
import { reconcileStuckCalls } from "@/lib/engine/reconcile";
import { resyncCallQueue } from "@/lib/queue/sweeper";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";
import { writeHeartbeat } from "@/lib/engine/heartbeat";

const BOOTED_AT = Date.now();

function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandledRejection — exiting for restart:", reason);
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    console.error("[worker] uncaughtException — exiting for restart:", err);
    process.exit(1);
  });
}

// Lightweight health endpoint so the hosting platform (Railway/Render/Fly) can
// detect a dead worker and restart it. Pings Redis so "up" means the engine can
// actually consume jobs, not just that the process is alive.
function startHealthServer(): Server {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer(async (req, res) => {
    if (req.url !== "/health" && req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    let redisOk = false;
    let redisReason: string | undefined;
    try {
      const health = await probeRedisQueueHealth();
      redisOk = health.ok;
      redisReason = health.reason;
    } catch {
      redisOk = false;
    }
    const body = JSON.stringify({
      ok: redisOk,
      redis: redisOk ? "up" : "down",
      redisReason,
      uptimeSec: Math.round((Date.now() - BOOTED_AT) / 1000),
    });
    res.writeHead(redisOk ? 200 : 503, { "content-type": "application/json" });
    res.end(body);
  });
  server.listen(port, () => console.log(`[worker] health server on :${port}/health`));
  return server;
}

async function main() {
  installCrashGuards();
  console.log("[worker] starting Upsurge engine…");

  if (!process.env.REDIS_URL && process.env.NODE_ENV === "production") {
    throw new Error("REDIS_URL is required in production — the worker cannot consume jobs without it");
  }

  const healthServer = startHealthServer();
  const pollWorker = startPollWorker();
  const callWorker = startCallWorker();

  // Heartbeat for Vercel failover crons — written only when BullMQ can run.
  // Upstash quota exhaustion still allows PING; probe queue ops to avoid a
  // zombie worker that looks healthy while dials are stuck.
  const writeHealthyHeartbeat = async () => {
    const health = await probeRedisQueueHealth();
    if (!health.ok) {
      throw new Error(`Redis queue unhealthy: ${health.reason ?? "unknown"}`);
    }
    await writeHeartbeat();
  };

  const HEARTBEAT_BASE_MS = 30_000;
  const HEARTBEAT_MAX_MS = 5 * 60_000;
  let heartbeatDelayMs = HEARTBEAT_BASE_MS;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const scheduleHeartbeat = () => {
    heartbeatTimer = setTimeout(async () => {
      try {
        await writeHealthyHeartbeat();
        heartbeatDelayMs = HEARTBEAT_BASE_MS;
      } catch (e) {
        console.error("[heartbeat] health/write error:", e);
        heartbeatDelayMs = Math.min(heartbeatDelayMs * 2, HEARTBEAT_MAX_MS);
      } finally {
        scheduleHeartbeat();
      }
    }, heartbeatDelayMs);
  };

  try {
    await writeHealthyHeartbeat();
  } catch (e) {
    console.error("[heartbeat] initial health/write error:", e);
    heartbeatDelayMs = Math.min(heartbeatDelayMs * 2, HEARTBEAT_MAX_MS);
  }
  scheduleHeartbeat();

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
      const summary = await reconcileStuckCalls({ olderThanMinutes: 1, limit: 250 });
      if (summary.reconciled || summary.failed) {
        console.log("[reconcile] stuck-call sweep:", summary);
      }
    } catch (e) {
      console.error("[reconcile] sweep error:", e);
    }
  }, 2 * 60_000);

  // Queue self-heal sweep: every 3 minutes, rebuild BullMQ dial jobs for durable
  // `call_queue_entries` rows that are due but have no live job (e.g. after a
  // worker redeploy or a Redis restart wiped the delayed-job set). Skipped
  // automatically when Redis/BullMQ is unavailable so we don't burn quota on
  // doomed requests — Vercel failover drain takes over instead.
  let sweepTimer: NodeJS.Timeout | null = setInterval(async () => {
    try {
      const summary = await resyncCallQueue({ limit: 500 });
      if (summary.reEnqueued) {
        console.log("[sweeper] call-queue self-heal:", summary);
      } else if (summary.redisSkipped) {
        console.warn("[sweeper] skipped — Redis queue unavailable (failover drain active)");
      }
    } catch (e) {
      console.error("[sweeper] resync error:", e);
    }
  }, 3 * 60_000);

  const shutdown = async () => {
    console.log("[worker] shutting down…");
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
    if (timer) clearInterval(timer);
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    healthServer.close();
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
