// =====================================================================
// POST|GET /api/admin/reconcile-stuck-calls
//
// Manual / cron-triggered backfill for calls left in `dialing` because
// their Retell `call_analyzed` webhook was never successfully processed
// (e.g. a signature mismatch returned 401 before the outcome handler ran).
//
// Delegates to reconcileStuckCalls() — the same logic the worker runs on a
// periodic self-heal sweep — so behaviour is identical whether triggered
// manually here or automatically by the worker.
//
// Auth: Bearer CRON_SECRET (same as /api/cron/daily-poll).
// Optional query params:
//   workspaceId        — limit to one workspace
//   agentId            — limit to one agent
//   limit              — max rows to scan (default 200, hard cap 500)
//   olderThanMinutes   — only touch calls dialed at least N minutes ago
//   dryRun=true        — report what would be reconciled without writing
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { reconcileStuckCalls } from "@/lib/engine/reconcile";

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
  const limitParam = Number(url.searchParams.get("limit") ?? "200");
  const olderThanParam = url.searchParams.get("olderThanMinutes");

  const summary = await reconcileStuckCalls({
    workspaceId: url.searchParams.get("workspaceId"),
    agentId: url.searchParams.get("agentId"),
    limit: Number.isFinite(limitParam) ? limitParam : 200,
    olderThanMinutes: olderThanParam ? Number(olderThanParam) || 0 : 0,
    dryRun: url.searchParams.get("dryRun") === "true",
  });

  return NextResponse.json(summary);
}

export const POST = handle;
export const GET = handle;
