// =====================================================================
// GET/POST /api/cron/drain-queue
// Redis-independent failover: claim due call_queue_entries and place calls
// directly via placeCall when either:
//   - the Railway worker heartbeat is stale (worker dead), or
//   - Redis/BullMQ is unavailable (quota/outage — PING can still succeed), or
//   - dial stall is detected (overdue pending + no recent dials in-window).
// Protect with CRON_SECRET. Runs every minute via Vercel Cron.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secure";
import {
  checkDialStalls,
  resolveFailoverDrainTrigger,
} from "@/lib/engine/dial-watchdog";
import { drainDueDials } from "@/lib/engine/drain";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1";

  const stallCheck = await checkDialStalls();
  const redisHealth = await probeRedisQueueHealth({ closeAfter: true });
  const trigger = resolveFailoverDrainTrigger({
    heartbeatStale: stallCheck.heartbeatStale,
    stalledAgentCount: stallCheck.stalled.length,
    redisUnhealthy: !redisHealth.ok,
  });

  if (!trigger) {
    return NextResponse.json({
      skipped: "worker_healthy",
      heartbeatAgeSec: stallCheck.heartbeatAgeSec,
      stalledAgents: 0,
      redis: redisHealth,
    });
  }

  const result = await drainDueDials({ dryRun });
  return NextResponse.json({
    failover: true,
    trigger,
    dryRun,
    redis: redisHealth,
    heartbeatAgeSec: stallCheck.heartbeatAgeSec,
    stalledAgents: stallCheck.stalled.length,
    stalled: stallCheck.stalled.map((s) => ({
      agentId: s.agentId,
      agentName: s.agentName,
      workspaceName: s.workspaceName,
      overduePending: s.overduePending,
      oldestPendingQueueDay: s.oldestPendingQueueDay,
    })),
    ...result,
  });
}

export const GET = handle;
export const POST = handle;
