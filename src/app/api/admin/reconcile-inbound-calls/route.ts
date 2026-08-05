// =====================================================================
// POST|GET /api/admin/reconcile-inbound-calls
//
// Replays missed Retell inbound call_analyzed webhooks through the
// productized inbound processor. Used by Vercel cron (*/5) and manual ops.
//
// Auth: Bearer CRON_SECRET.
// Optional query params:
//   workspaceId, agentId, lookbackHours, limitPerAgent, dryRun=true
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { reconcileInboundCalls } from "@/lib/engine/reconcile-inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const lookbackParam = Number(url.searchParams.get("lookbackHours") ?? "24");
  const limitParam = Number(url.searchParams.get("limitPerAgent") ?? "200");

  const summary = await reconcileInboundCalls({
    workspaceId: url.searchParams.get("workspaceId"),
    agentId: url.searchParams.get("agentId"),
    lookbackHours: Number.isFinite(lookbackParam) ? lookbackParam : 24,
    limitPerAgent: Number.isFinite(limitParam) ? limitParam : 200,
    dryRun: url.searchParams.get("dryRun") === "true",
  });

  return NextResponse.json(summary);
}

export const POST = handle;
export const GET = handle;
