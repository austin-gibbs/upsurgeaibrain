// =====================================================================
// GET/POST /api/cron/dial-watchdog
// Smoke alarm: alert when dialing stalls during an open call window.
// Protect with CRON_SECRET. Runs every 5 minutes via Vercel Cron.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/secure";
import { sendOpsAlert } from "@/lib/alerts";
import {
  checkDialStalls,
  formatDialStallAlert,
} from "@/lib/engine/dial-watchdog";

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
  let alerted = false;

  if (result.stalled.length > 0) {
    alerted = await sendOpsAlert(formatDialStallAlert(result));
  }

  return NextResponse.json({ ...result, alerted });
}

export const GET = handle;
export const POST = handle;
