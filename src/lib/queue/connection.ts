// Shared Redis connection for BullMQ (queues + workers).
import { Redis } from "ioredis";

let connection: Redis | null = null;

export function getRedis(): Redis {
  if (connection) return connection;
  connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null, // required by BullMQ
  });
  return connection;
}
