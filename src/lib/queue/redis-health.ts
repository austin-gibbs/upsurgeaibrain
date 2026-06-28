// Redis + BullMQ liveness — PING alone is insufficient on Upstash because quota
// exhaustion still allows PING while Lua/eval (used by BullMQ) fails.
import { closeRedis, getRedis } from "./connection";
import { closeCallQueue, getCallQueue } from "./queues";

export interface RedisHealthResult {
  ok: boolean;
  reason?: string;
}

export function isRedisQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("max requests limit exceeded") || msg.includes("max_request");
}

export function redisFailureReason(err: unknown): string {
  if (isRedisQuotaError(err)) return "quota_exceeded";
  const msg = err instanceof Error ? err.message : String(err);
  if (/econnrefused|enotfound|etimedout|connection/.test(msg.toLowerCase())) {
    return "connection_failed";
  }
  return "queue_unavailable";
}

/**
 * Verify Redis can run BullMQ operations (not just PING).
 * Pass closeAfter:true from serverless handlers to release the connection.
 */
export async function probeRedisQueueHealth(opts?: {
  closeAfter?: boolean;
}): Promise<RedisHealthResult> {
  if (!process.env.REDIS_URL) return { ok: false, reason: "no_redis_url" };

  try {
    const redis = getRedis();
    if (redis.status !== "ready") await redis.connect();

    const pong = await redis.ping();
    if (pong !== "PONG") return { ok: false, reason: "ping_failed" };

    const queue = getCallQueue();
    await queue.getJobCounts("waiting");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: redisFailureReason(err) };
  } finally {
    if (opts?.closeAfter) {
      await closeCallQueue().catch(() => {});
      closeRedis();
    }
  }
}
