// =====================================================================
// GET /api/health/engine
// Confirms the Vercel side can reach the SAME Redis the worker consumes.
// Use this after setting REDIS_URL on Vercel to verify the app can enqueue
// jobs that the cloud worker will pick up. Returns 503 if Redis is down.
// =====================================================================
import { NextResponse } from "next/server";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await probeRedisQueueHealth({ closeAfter: true });

  return NextResponse.json(
    {
      ok: health.ok,
      redis: health.ok ? "up" : "down",
      reason: health.reason,
    },
    { status: health.ok ? 200 : 503 }
  );
}
