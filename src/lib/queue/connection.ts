// Shared Redis connection for BullMQ (queues + workers).
import { Redis, type RedisOptions } from "ioredis";

let connection: Redis | null = null;

function isWorkerRuntime(): boolean {
  if (process.env.UPSURGE_WORKER === "true") return true;
  return process.argv.some((arg) => arg.replace(/\\/g, "/").includes("worker/index"));
}

function redisOptions(): RedisOptions {
  const worker = isWorkerRuntime();
  return {
    maxRetriesPerRequest: null, // required by BullMQ
    family: 0, // resolve IPv4 + IPv6 (Railway private networking is IPv6-only)
    lazyConnect: true,
  ...(worker
    ? {
        // Long-running worker: survive transient Redis blips without stalling consumers.
        enableOfflineQueue: true,
        connectTimeout: 20_000,
        retryStrategy: (times: number) => Math.min(times * 500, 10_000),
        reconnectOnError: (err: Error) => {
          const msg = err.message.toLowerCase();
          return msg.includes("readonly") || msg.includes("econnreset") || msg.includes("etimedout");
        },
      }
    : {
        // Serverless API routes: fail fast so handlers don't hang indefinitely.
        connectTimeout: 10_000,
        commandTimeout: 15_000,
        enableOfflineQueue: false,
      }),
  };
}

export function getRedis(): Redis {
  if (connection) return connection;
  connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", redisOptions());
  return connection;
}

/**
 * Open the shared connection only while it is still lazy.
 *
 * BullMQ starts connecting the ioredis instance it is handed, so calling
 * connect() unconditionally after constructing a Queue races that and throws
 * "Redis is already connecting/connected" — which silently loses the enqueue.
 */
export async function ensureRedisConnected(): Promise<Redis> {
  const redis = getRedis();
  if (redis.status === "wait") await redis.connect();
  return redis;
}

/** Tear down the singleton connection (call after one-off API enqueues). */
export function closeRedis(): void {
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}
