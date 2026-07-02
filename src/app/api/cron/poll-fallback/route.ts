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
import { pollAgent } from "@/lib/engine/poller";
import { isAgentEligibleForPollTick } from "@/lib/engine/poll-schedule";
import {
  agentLacksRecentPollCoverage,
  shouldPollAgentInFailover,
} from "@/lib/engine/poll-coverage";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";
import type { Agent, AgentCallConfig } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

type AgentRow = Pick<Agent, "id" | "status" | "direction" | "workspace_id"> & {
  agent_call_configs:
    | Pick<
        AgentCallConfig,
        | "daily_run_at"
        | "call_window_start"
        | "call_window_end"
        | "call_window_days"
        | "max_attempts_per_contact"
      >
    | Pick<
        AgentCallConfig,
        | "daily_run_at"
        | "call_window_start"
        | "call_window_end"
        | "call_window_days"
        | "max_attempts_per_contact"
      >[]
    | null;
  workspaces: { timezone: string; is_active: boolean } | null;
};

function pickConfig(agent: AgentRow) {
  return Array.isArray(agent.agent_call_configs)
    ? agent.agent_call_configs[0]
    : agent.agent_call_configs;
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
    .returns<AgentRow[]>();
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
  const polled: string[] = [];
  const skippedAgents: string[] = [];
  const coverageBackfill: string[] = [];
  const results: Awaited<ReturnType<typeof pollAgent>>[] = [];

  for (const agent of agents) {
    const config = pickConfig(agent);
    const workspace = agent.workspaces;
    if (!config?.daily_run_at || !workspace?.is_active) {
      skippedAgents.push(agent.id);
      continue;
    }

    const pollTickEligible = isAgentEligibleForPollTick({
      timezone: workspace.timezone,
      dailyRunAt: config.daily_run_at,
      callWindowStart: config.call_window_start,
      callWindowEnd: config.call_window_end,
      callWindowDays: config.call_window_days,
    });
    const lacksPollCoverage = await agentLacksRecentPollCoverage(agent.id, {
      db: supabase,
    });

    if (
      !shouldPollAgentInFailover({
        infrastructureFailover,
        pollTickEligible,
        lacksPollCoverage,
      })
    ) {
      skippedAgents.push(agent.id);
      continue;
    }

    if (!infrastructureFailover && lacksPollCoverage) {
      coverageBackfill.push(agent.id);
    }

    const result = await pollAgent(agent.id, {
      skipRedis: true,
      triggerSource: "failover",
    });
    results.push(result);
    polled.push(agent.id);
  }

  if (polled.length === 0) {
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
    coverageBackfill,
    skippedAgents,
    results,
  });
}

export const GET = handle;
export const POST = handle;
