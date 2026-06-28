// =====================================================================
// GET/POST /api/cron/poll-fallback
// When the Railway worker heartbeat is stale, run pollAgent directly for
// each active outbound agent at/after its daily_run_at. Writes durable
// call_queue_entries without Redis. Protect with CRON_SECRET.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bearerMatches } from "@/lib/secure";
import { isHeartbeatStale, heartbeatAgeMs } from "@/lib/engine/heartbeat";
import { pollAgent } from "@/lib/engine/poller";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";
import {
  addDays,
  nowHHMMInTz,
  todayInTz,
  zonedDateTimeToUtcIso,
} from "@/lib/engine/cadence";
import type { Agent, AgentCallConfig } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

type AgentRow = Pick<Agent, "id" | "status" | "direction" | "workspace_id"> & {
  agent_call_configs:
    | Pick<AgentCallConfig, "daily_run_at" | "call_window_end" | "max_attempts_per_contact">
    | Pick<AgentCallConfig, "daily_run_at" | "call_window_end" | "max_attempts_per_contact">[]
    | null;
  workspaces: { timezone: string; is_active: boolean } | null;
};

function pickConfig(agent: AgentRow) {
  return Array.isArray(agent.agent_call_configs)
    ? agent.agent_call_configs[0]
    : agent.agent_call_configs;
}

async function hasMissedDailyPoll(
  supabase: ReturnType<typeof createServiceClient>,
  agent: AgentRow,
  config: Pick<AgentCallConfig, "daily_run_at" | "max_attempts_per_contact">,
  timezone: string
): Promise<boolean> {
  const today = todayInTz(timezone);
  const tomorrow = addDays(today, 1);
  const dayStart = zonedDateTimeToUtcIso(timezone, today, "00:00");
  const dayEnd = zonedDateTimeToUtcIso(timezone, tomorrow, "00:00");

  const [{ count: queueRowsToday }, { count: callsToday }, { count: dueContacts }] =
    await Promise.all([
      supabase
        .from("call_queue_entries")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agent.id)
        .eq("queue_day", today),
      supabase
        .from("calls")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agent.id)
        .gte("queued_at", dayStart)
        .lt("queued_at", dayEnd),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", agent.workspace_id)
        .eq("is_terminal", false)
        .lt("attempt_count", config.max_attempts_per_contact)
        .not("phones", "eq", "{}")
        .or(`last_called_on.is.null,last_called_on.lt.${today}`)
        .or(`next_eligible_on.is.null,next_eligible_on.lte.${today}`),
    ]);

  return (
    (queueRowsToday ?? 0) === 0 &&
    (callsToday ?? 0) === 0 &&
    (dueContacts ?? 0) > 0
  );
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

  const supabase = createServiceClient();
  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, status, direction,
       workspace_id,
       agent_call_configs(daily_run_at, call_window_end, max_attempts_per_contact),
       workspaces(timezone, is_active)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<AgentRow[]>();

  const polled: string[] = [];
  const skippedAgents: string[] = [];
  const missedDailyPollAgents: string[] = [];
  const results: Awaited<ReturnType<typeof pollAgent>>[] = [];

  for (const agent of agents ?? []) {
    const config = pickConfig(agent);
    const workspace = agent.workspaces;
    if (!config || !workspace?.is_active) {
      skippedAgents.push(agent.id);
      continue;
    }

    const now = nowHHMMInTz(workspace.timezone);
    if (now < config.daily_run_at) {
      skippedAgents.push(agent.id);
      continue;
    }
    if (now > config.call_window_end) {
      skippedAgents.push(agent.id);
      continue;
    }

    const missedDailyPoll = await hasMissedDailyPoll(
      supabase,
      agent,
      config,
      workspace.timezone
    );
    if (!stale && !missedDailyPoll && redisOk) {
      skippedAgents.push(agent.id);
      continue;
    }
    if (missedDailyPoll) missedDailyPollAgents.push(agent.id);

    // In fallback mode the durable Postgres queue is the source of truth.
    // Avoid touching Redis here because Redis outage/quota exhaustion is one
    // of the reasons this route takes over.
    const result = await pollAgent(agent.id, { skipRedis: true });
    results.push(result);
    polled.push(agent.id);
  }

  if (!stale && redisOk && polled.length === 0) {
    return NextResponse.json({
      skipped: "worker_healthy",
      heartbeatAgeSec,
      redis: redisHealth,
      skippedAgents,
    });
  }

  const trigger = !redisOk
    ? "redis_unavailable"
    : stale
      ? "heartbeat_stale"
      : "missed_daily_poll";

  return NextResponse.json({
    failover: true,
    trigger,
    heartbeatAgeSec,
    redis: redisHealth,
    polled,
    missedDailyPollAgents,
    skippedAgents,
    results,
  });
}

export const GET = handle;
export const POST = handle;
