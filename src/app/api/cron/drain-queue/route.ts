// =====================================================================
// GET/POST /api/cron/drain-queue
// Redis-independent failover: claim due call_queue_entries and place calls
// directly via placeCall when either:
//   - the Railway worker heartbeat is stale (worker dead), or
//   - dial stall is detected (zombie worker: heartbeat ok but overdue pending
//     rows and no recent dials during an open call window).
// Protect with CRON_SECRET. Runs every minute via Vercel Cron.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secure";
import {
  checkDialStalls,
  resolveFailoverDrainTrigger,
} from "@/lib/engine/dial-watchdog";
import { drainDueDials } from "@/lib/engine/drain";

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

  const stallCheck = await checkDialStalls();
  const trigger = resolveFailoverDrainTrigger({
    heartbeatStale: stallCheck.heartbeatStale,
    stalledAgentCount: stallCheck.stalled.length,
  });

  if (!trigger) {
    return NextResponse.json({
      skipped: "worker_healthy",
      heartbeatAgeSec: stallCheck.heartbeatAgeSec,
      stalledAgents: 0,
    });
  }

  const result = await drainDueDials();
  return NextResponse.json({
    failover: true,
    trigger,
    heartbeatAgeSec: stallCheck.heartbeatAgeSec,
    stalledAgents: stallCheck.stalled.length,
    stalled: stallCheck.stalled.map((s) => ({
      agentId: s.agentId,
      agentName: s.agentName,
      workspaceName: s.workspaceName,
      overduePending: s.overduePending,
    })),
    ...result,
  });
}

export const GET = handle;
export const POST = handle;
