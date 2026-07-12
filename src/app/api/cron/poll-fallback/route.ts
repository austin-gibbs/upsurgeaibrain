// =====================================================================
// GET/POST /api/cron/poll-fallback
// Failover polling when the worker is unhealthy OR poll coverage is missing
// during an open call window. Writes durable call_queue_entries without Redis.
// Protect with CRON_SECRET.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bearerMatches } from "@/lib/secure";
import { isHeartbeatStale, heartbeatAgeMs } from "@/lib/engine/heartbeat";
import {
  runPollFailoverBatch,
  selectPollFallbackCandidates,
  type PollFallbackAgentRow,
} from "@/lib/engine/poll-fallback-runner";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

async function loadOutboundAgents() {
  const supabase = createServiceClient();
  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, status, direction,
       workspace_id,
       agent_call_configs(daily_run_at, call_window_start, call_window_end, call_window_days, max_attempts_per_contact),
       workspaces(timezone, is_active)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<PollFallbackAgentRow[]>();
  return { supabase, agents: agents ?? [] };
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const stale = await isHeartbeatStale();
  const redisHealth = await probeRedisQueueHealth({ closeAfter: true });
  const redisOk = redisHealth.ok;
  const heartbeatAgeSec = await heartbeatAgeMs().then((ms) =>
    ms == null ? null : Math.round(ms / 1000)
  );
  const infrastructureFailover = stale || !redisOk;

  const { supabase, agents } = await loadOutboundAgents();
  const skippedAgents: string[] = [];
  const candidates = await selectPollFallbackCandidates(
    agents,
    infrastructureFailover,
    supabase
  );

  const polledAgentIds = new Set(candidates.map((c) => c.agentId));
  for (const agent of agents) {
    if (!polledAgentIds.has(agent.id)) skippedAgents.push(agent.id);
  }

  if (candidates.length === 0) {
    if (!infrastructureFailover) {
      return NextResponse.json({
        skipped: "worker_healthy",
        heartbeatAgeSec,
        redis: redisHealth,
        skippedAgents,
      });
    }
    return NextResponse.json({
      skipped: "no_eligible_agents",
      heartbeatAgeSec,
      redis: redisHealth,
      skippedAgents,
    });
  }

  const coverageBackfill = candidates
    .filter((c) => c.lacksPollCoverage && !infrastructureFailover)
    .map((c) => c.agentId);

  const batch = await runPollFailoverBatch(
    candidates.map((c) => c.agentId),
    { skipRedis: true, triggerSource: "failover" }
  );

  const polled = batch.filter((r) => r.ok).map((r) => r.agentId);
  const failed = batch.filter((r) => !r.ok);
  const results = batch.filter((r) => r.result).map((r) => r.result!);

  const trigger = !redisOk
    ? "redis_unavailable"
    : stale
      ? "heartbeat_stale"
      : "poll_coverage_gap";

  return NextResponse.json({
    failover: true,
    trigger,
    heartbeatAgeSec,
    redis: redisHealth,
    polled,
    failed: failed.map((f) => ({
      agentId: f.agentId,
      error: f.error,
      timedOut: f.timedOut ?? false,
    })),
    coverageBackfill,
    skippedAgents,
    results,
  });
}

export const GET = handle;
export const POST = handle;
