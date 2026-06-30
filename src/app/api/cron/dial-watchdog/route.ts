// =====================================================================
// GET/POST /api/cron/dial-watchdog
// Smoke alarm: alert when dialing stalls during an open call window.
// Protect with CRON_SECRET. Runs every 5 minutes via Vercel Cron.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secure";
import { sendOpsAlert } from "@/lib/alerts";
import { checkDialStalls, formatDialStallAlert } from "@/lib/engine/dial-watchdog";
import { reconcileZombieDialingRows } from "@/lib/engine/call-queue";
import { createServiceClient } from "@/lib/supabase/server";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await checkDialStalls();
  const redisHealth = await probeRedisQueueHealth({ closeAfter: true });
  const zombiesCleared = await reconcileZombieDialingRows(createServiceClient()).catch(
    () => 0
  );
  let alerted = false;

  if (result.stalled.length > 0) {
    const redisLine = !redisHealth.ok
      ? `\nRedis: *UNAVAILABLE* (${redisHealth.reason ?? "unknown"}) — failover drain should be active.`
      : "";
    alerted = await sendOpsAlert(formatDialStallAlert(result) + redisLine);
  } else if (!redisHealth.ok) {
    alerted = await sendOpsAlert(
      `:warning: *Redis queue unavailable* (${redisHealth.reason ?? "unknown"}). ` +
        "BullMQ dials are blocked; Vercel failover drain should place calls during open windows."
    );
  }

  return NextResponse.json({ ...result, redis: redisHealth, alerted, zombiesCleared });
}

export const GET = handle;
export const POST = handle;
