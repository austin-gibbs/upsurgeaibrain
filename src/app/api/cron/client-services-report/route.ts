// =====================================================================
// GET/POST /api/cron/client-services-report
// App-DB-only client-services reporting for all active workspaces, used to
// drive the twice-daily #client-services Slack update. Protect with
// CRON_SECRET (Vercel Cron sends it automatically as a Bearer token).
//
// Per workspace: each agent's day call count + spend (Retell cost), a
// workspace day total, month-to-date talk minutes vs the 1200-minute plan
// (with % used), and the $0.12/min overage bill. Plus a grand total.
//
// Modes (query params):
//   format=slack            — return rendered Markdown as text (preview, no post)
//   format=json (default)   — return the raw report JSON (no post)
//   post=slack              — post the rendered report to the #client-services
//                             webhook, but ONLY when the current Mountain-Time
//                             hour is in POST_HOURS (so an hourly Vercel cron
//                             fires it at 12pm & 5pm MT, DST-correct). Add
//                             force=1 to post immediately regardless of hour
//                             (use for manual testing).
//   tz=...                  — IANA timezone for the day/month windows
//                             (default America/Denver)
//
// Slack target: CLIENT_SERVICES_SLACK_WEBHOOK_URL (a #client-services
// incoming webhook). On build failure in post mode, posts a :warning: line
// instead of fabricating numbers.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bearerMatches } from "@/lib/secure";
import { postSlackWebhook } from "@/lib/alerts";
import {
  buildClientServicesReport,
  formatClientServicesSlack,
} from "@/lib/reporting/client-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Local hours (in the report timezone) at which the cron should post.
const POST_HOURS = [12, 17]; // 12:00 PM and 5:00 PM MT

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

function localHour(now: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  return Number(h) % 24;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const tz = url.searchParams.get("tz") ?? "America/Denver";
  const format = url.searchParams.get("format") ?? "json";
  const post = url.searchParams.get("post");
  const force = url.searchParams.get("force") === "1";

  // --- Cron post mode: build + push to Slack, hour-gated unless forced. ---
  if (post === "slack") {
    const hour = localHour(new Date(), tz);
    if (!force && !POST_HOURS.includes(hour)) {
      return NextResponse.json({ skipped: true, reason: "outside post hours", localHour: hour });
    }
    const webhook = process.env.CLIENT_SERVICES_SLACK_WEBHOOK_URL?.trim();
    if (!webhook) {
      return NextResponse.json(
        { error: "CLIENT_SERVICES_SLACK_WEBHOOK_URL not set" },
        { status: 500 }
      );
    }
    try {
      const report = await buildClientServicesReport(createServiceClient(), { tz });
      const text = formatClientServicesSlack(report);
      const ok = await postSlackWebhook(webhook, text);
      return NextResponse.json({ posted: ok, localHour: hour });
    } catch (e) {
      const message = e instanceof Error ? e.message : "report failed";
      // Mirror the original task's contract: warn, never fabricate numbers.
      await postSlackWebhook(
        webhook,
        `:warning: AI Agent client-services report failed to generate — ${message}`
      );
      return NextResponse.json({ posted: false, error: message }, { status: 500 });
    }
  }

  // --- Preview/fetch mode: return the report, no Slack post. ---
  try {
    const report = await buildClientServicesReport(createServiceClient(), { tz });
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
