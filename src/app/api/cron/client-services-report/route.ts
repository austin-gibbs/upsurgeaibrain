// =====================================================================
// GET/POST /api/cron/client-services-report
// App-DB-only client-services reporting for all active workspaces, used to
// drive the twice-daily #client-services Slack update. Protect with
// CRON_SECRET.
//
// Per workspace: each agent's day call count + spend (Retell cost), a
// workspace day total, month-to-date talk minutes vs the 1200-minute plan
// (with % used), and the $0.12/min overage bill. Plus a grand total.
//
// Query params:
//   tz      — IANA timezone for the day/month windows (default America/Denver)
//   format  — "json" (default) | "slack" (returns rendered Markdown as text)
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bearerMatches } from "@/lib/secure";
import {
  buildClientServicesReport,
  formatClientServicesSlack,
} from "@/lib/reporting/client-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const tz = url.searchParams.get("tz") ?? "America/Denver";
  const format = url.searchParams.get("format") ?? "json";

  const db = createServiceClient();

  try {
    const report = await buildClientServicesReport(db, { tz });
    if (format === "slack") {
      return new NextResponse(formatClientServicesSlack(report), {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return NextResponse.json(report);
  } catch (e) {
    const message = e instanceof Error ? e.message : "report failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
