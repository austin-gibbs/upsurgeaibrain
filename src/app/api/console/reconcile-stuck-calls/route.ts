// =====================================================================
// POST /api/console/reconcile-stuck-calls — admin-gated stuck-call backfill.
// Same reconcileStuckCalls() as the cron route; session+admin gated for UI.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { reconcileStuckCalls } from "@/lib/engine/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const limitParam = Number(
    url.searchParams.get("limit") ?? (body as { limit?: number }).limit ?? "200"
  );
  const olderThanParam =
    url.searchParams.get("olderThanMinutes") ??
    (body as { olderThanMinutes?: number }).olderThanMinutes;

  const summary = await reconcileStuckCalls({
    workspaceId:
      url.searchParams.get("workspaceId") ??
      (body as { workspaceId?: string }).workspaceId ??
      null,
    agentId:
      url.searchParams.get("agentId") ??
      (body as { agentId?: string }).agentId ??
      null,
    limit: Number.isFinite(limitParam) ? limitParam : 200,
    olderThanMinutes: olderThanParam ? Number(olderThanParam) || 0 : 0,
    dryRun:
      url.searchParams.get("dryRun") === "true" ||
      (body as { dryRun?: boolean }).dryRun === true,
  });

  return NextResponse.json(summary);
}
