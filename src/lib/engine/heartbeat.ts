// Worker liveness signal for Postgres-backed failover crons on Vercel.
import { createServiceClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

export const HEARTBEAT_ID = "worker";
/** Failover activates when the worker has not written within this window. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

type DbClient = ReturnType<typeof createServiceClient>;
type EngineHeartbeatUpsert =
  Database["public"]["Tables"]["engine_heartbeat"]["Insert"];

export interface EngineLivenessRow {
  last_seen_at: string | null;
  scheduler_last_tick_at: string | null;
  scheduler_last_enqueued_at: string | null;
  poll_worker_last_seen_at: string | null;
  call_worker_last_seen_at: string | null;
  redis_last_ok_at: string | null;
  redis_last_ok: boolean | null;
}

export interface EngineLivenessPatch {
  lastSeenAt?: string;
  schedulerLastTickAt?: string;
  schedulerLastEnqueuedAt?: string;
  pollWorkerLastSeenAt?: string;
  callWorkerLastSeenAt?: string;
  redisLastOkAt?: string;
  redisLastOk?: boolean;
}

export function isHeartbeatStaleAt(
  lastSeenAt: string | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = HEARTBEAT_STALE_MS
): boolean {
  if (!lastSeenAt) return true;
  const ts = new Date(lastSeenAt).getTime();
  if (Number.isNaN(ts)) return true;
  return nowMs - ts > staleMs;
}

function patchToUpsert(patch: EngineLivenessPatch): EngineHeartbeatUpsert {
  const row: EngineHeartbeatUpsert = { id: HEARTBEAT_ID };
  if (patch.lastSeenAt !== undefined) row.last_seen_at = patch.lastSeenAt;
  if (patch.schedulerLastTickAt !== undefined) {
    row.scheduler_last_tick_at = patch.schedulerLastTickAt;
  }
  if (patch.schedulerLastEnqueuedAt !== undefined) {
    row.scheduler_last_enqueued_at = patch.schedulerLastEnqueuedAt;
  }
  if (patch.pollWorkerLastSeenAt !== undefined) {
    row.poll_worker_last_seen_at = patch.pollWorkerLastSeenAt;
  }
  if (patch.callWorkerLastSeenAt !== undefined) {
    row.call_worker_last_seen_at = patch.callWorkerLastSeenAt;
  }
  if (patch.redisLastOkAt !== undefined) row.redis_last_ok_at = patch.redisLastOkAt;
  if (patch.redisLastOk !== undefined) row.redis_last_ok = patch.redisLastOk;
  return row;
}

/** Partial upsert of engine liveness fields on the singleton heartbeat row. */
export async function writeEngineLiveness(
  patch: EngineLivenessPatch,
  db?: DbClient
): Promise<void> {
  const supabase = db ?? createServiceClient();
  const row = patchToUpsert(patch);
  const fieldCount = Object.keys(row).filter((key) => key !== "id").length;
  if (fieldCount === 0) return;

  const { error } = await supabase.from("engine_heartbeat").upsert(row);
  if (error) throw new Error(error.message);
}

/** Upsert the singleton heartbeat row (called by the Railway worker). */
export async function writeHeartbeat(db?: DbClient): Promise<void> {
  await writeEngineLiveness({ lastSeenAt: new Date().toISOString() }, db);
}

export async function writeSchedulerLiveness(
  enqueuedCount: number,
  db?: DbClient
): Promise<void> {
  const now = new Date().toISOString();
  const patch: EngineLivenessPatch = { schedulerLastTickAt: now };
  if (enqueuedCount > 0) patch.schedulerLastEnqueuedAt = now;
  await writeEngineLiveness(patch, db);
}

export async function writePollWorkerLiveness(db?: DbClient): Promise<void> {
  await writeEngineLiveness(
    { pollWorkerLastSeenAt: new Date().toISOString() },
    db
  );
}

export async function writeCallWorkerLiveness(db?: DbClient): Promise<void> {
  await writeEngineLiveness(
    { callWorkerLastSeenAt: new Date().toISOString() },
    db
  );
}

export async function writeRedisLiveness(
  ok: boolean,
  db?: DbClient
): Promise<void> {
  const patch: EngineLivenessPatch = { redisLastOk: ok };
  if (ok) patch.redisLastOkAt = new Date().toISOString();
  await writeEngineLiveness(patch, db);
}

export async function readEngineLiveness(
  db?: DbClient
): Promise<EngineLivenessRow | null> {
  const supabase = db ?? createServiceClient();
  const { data, error } = await supabase
    .from("engine_heartbeat")
    .select(
      "last_seen_at, scheduler_last_tick_at, scheduler_last_enqueued_at, poll_worker_last_seen_at, call_worker_last_seen_at, redis_last_ok_at, redis_last_ok"
    )
    .eq("id", HEARTBEAT_ID)
    .maybeSingle<EngineLivenessRow>();
  if (error) throw new Error(error.message);
  return data;
}

export async function readHeartbeat(
  db?: DbClient
): Promise<{ lastSeenAt: string | null }> {
  const row = await readEngineLiveness(db);
  return { lastSeenAt: row?.last_seen_at ?? null };
}

export async function isHeartbeatStale(
  db?: DbClient,
  staleMs: number = HEARTBEAT_STALE_MS
): Promise<boolean> {
  const { lastSeenAt } = await readHeartbeat(db);
  return isHeartbeatStaleAt(lastSeenAt, Date.now(), staleMs);
}

export async function heartbeatAgeMs(db?: DbClient): Promise<number | null> {
  const { lastSeenAt } = await readHeartbeat(db);
  if (!lastSeenAt) return null;
  const ts = new Date(lastSeenAt).getTime();
  if (Number.isNaN(ts)) return null;
  return Date.now() - ts;
}
