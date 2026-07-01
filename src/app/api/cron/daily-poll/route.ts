// =====================================================================
// GET/POST /api/cron/daily-poll
// External-cron entrypoint for the scheduler. Protect with CRON_SECRET.
// Configure an every-minute cron (e.g. Vercel Cron) to hit this, OR rely
// on the worker's internal scheduler. Poll jobs are bucketed every 2 minutes
// during each agent's call window.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { tickScheduler } from "@/lib/engine/scheduler";
import { bearerMatches } from "@/lib/secure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  // Constant-time compare so timing can't be used to recover CRON_SECRET.
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await tickScheduler();
  return NextResponse.json(result);
}

export const GET = handle;
export const POST = handle;
