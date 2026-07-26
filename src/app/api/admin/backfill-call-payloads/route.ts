// =====================================================================
// POST|GET /api/admin/backfill-call-payloads
//
// Repairs the fulfillment report's month-to-date minutes/spend when
// completed calls are missing their stored Retell webhook body
// (`raw_payload`). Those calls contribute zero minutes and zero spend,
// so app totals drift below Retell's usage dashboard. This re-fetches
// each affected call from Retell and patches only `raw_payload`.
//
// See src/lib/engine/backfill-payloads.ts for the full rationale and why
// this is distinct from the stuck-`dialing` reconciler.
//
// Auth: Bearer CRON_SECRET (same as /api/admin/reconcile-stuck-calls).
// Optional query params:
//   workspaceId   — limit to one workspace
//   agentId       — limit to one agent
//   sinceIso      — only calls completed at/after this ISO instant
//                   (default: start of current UTC month)
//   limit         — max rows to scan (default 200, hard cap 1000)
//   dryRun=true   — report recoverable minutes/spend without writing
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { backfillCallPayloads } from "@/lib/engine/backfill-payloads";

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

  const summary = await backfillCallPayloads({
    workspaceId: url.searchParams.get("workspaceId"),
    agentId: url.searchParams.get("agentId"),
    sinceIso: url.searchParams.get("sinceIso"),
    limit: Number.isFinite(limitParam) ? limitParam : 200,
    dryRun: url.searchParams.get("dryRun") === "true",
  });

  return NextResponse.json(summary);
}

export const POST = handle;
export const GET = handle;
