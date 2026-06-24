// =====================================================================
// GET /api/health/engine
// Confirms the Vercel side can reach the SAME Redis the worker consumes.
// Use this after setting REDIS_URL on Vercel to verify the app can enqueue
// jobs that the cloud worker will pick up. Returns 503 if Redis is down.
// =====================================================================
import { NextResponse } from "next/server";
import { getRedis, closeRedis } from "@/lib/queue/connection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let redisOk = false;
  try {
    const pong = await getRedis().ping();
    redisOk = pong === "PONG";
  } catch {
    redisOk = false;
  } finally {
    // One-off probe on serverless — don't leak the connection.
    closeRedis();
  }

  return NextResponse.json(
    { ok: redisOk, redis: redisOk ? "up" : "down" },
    { status: redisOk ? 200 : 503 }
  );
}
