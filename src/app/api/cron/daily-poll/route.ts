// =====================================================================
// GET/POST /api/cron/daily-poll
// External-cron entrypoint for the scheduler. Protect with CRON_SECRET.
// Configure an every-minute cron (e.g. Vercel Cron) to hit this, OR rely
// on the worker's internal scheduler and leave this unused.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { tickScheduler } from "@/lib/engine/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}`;
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
