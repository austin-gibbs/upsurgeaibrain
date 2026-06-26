// =====================================================================
// GET/POST /api/cron/drain-queue
// Redis-independent failover: when the Railway worker heartbeat is stale,
// claim due call_queue_entries and place calls directly via placeCall.
// Protect with CRON_SECRET. Runs every minute via Vercel Cron.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secure";
import { isHeartbeatStale, heartbeatAgeMs } from "@/lib/engine/heartbeat";
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

  const stale = await isHeartbeatStale();
  const heartbeatAgeSec = await heartbeatAgeMs().then((ms) =>
    ms == null ? null : Math.round(ms / 1000)
  );

  if (!stale) {
    return NextResponse.json({
      skipped: "worker_healthy",
      heartbeatAgeSec,
    });
  }

  const result = await drainDueDials();
  return NextResponse.json({
    failover: true,
    heartbeatAgeSec,
    ...result,
  });
}

export const GET = handle;
export const POST = handle;
