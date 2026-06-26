// Worker liveness signal for Postgres-backed failover crons on Vercel.
import { createServiceClient } from "@/lib/supabase/server";

export const HEARTBEAT_ID = "worker";
/** Failover activates when the worker has not written within this window. */
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

type DbClient = ReturnType<typeof createServiceClient>;

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

/** Upsert the singleton heartbeat row (called by the Railway worker). */
export async function writeHeartbeat(db?: DbClient): Promise<void> {
  const supabase = db ?? createServiceClient();
  const { error } = await supabase
    .from("engine_heartbeat")
    .upsert({ id: HEARTBEAT_ID, last_seen_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function readHeartbeat(
  db?: DbClient
): Promise<{ lastSeenAt: string | null }> {
  const supabase = db ?? createServiceClient();
  const { data, error } = await supabase
    .from("engine_heartbeat")
    .select("last_seen_at")
    .eq("id", HEARTBEAT_ID)
    .maybeSingle<{ last_seen_at: string }>();
  if (error) throw new Error(error.message);
  return { lastSeenAt: data?.last_seen_at ?? null };
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
