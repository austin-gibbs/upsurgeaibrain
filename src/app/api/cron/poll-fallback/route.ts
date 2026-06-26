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
import { nowHHMMInTz } from "@/lib/engine/cadence";
import type { Agent, AgentCallConfig } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  return bearerMatches(req.headers.get("authorization"), process.env.CRON_SECRET);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const stale = await isHeartbeatStale();
  const heartbeatAgeSec = await heartbeatAgeMs().then((ms) =>
    ms == null ? null : Math.round(ms / 1000)
  );

  if (!stale) {
    return NextResponse.json({
      skipped: "worker_healthy",
      heartbeatAgeSec,
    });
  }

  const supabase = createServiceClient();
  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, status, direction,
       agent_call_configs(daily_run_at),
       workspaces(timezone, is_active)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<
      (Pick<Agent, "id" | "status" | "direction"> & {
        agent_call_configs: Pick<AgentCallConfig, "daily_run_at"> | Pick<AgentCallConfig, "daily_run_at">[] | null;
        workspaces: { timezone: string; is_active: boolean } | null;
      })[]
    >();

  const polled: string[] = [];
  const skippedAgents: string[] = [];
  const results: Awaited<ReturnType<typeof pollAgent>>[] = [];

  for (const agent of agents ?? []) {
    const config = Array.isArray(agent.agent_call_configs)
      ? agent.agent_call_configs[0]
      : agent.agent_call_configs;
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

    const result = await pollAgent(agent.id);
    results.push(result);
    polled.push(agent.id);
  }

  return NextResponse.json({
    failover: true,
    heartbeatAgeSec,
    polled,
    skippedAgents,
    results,
  });
}

export const GET = handle;
export const POST = handle;
