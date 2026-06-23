// =====================================================================
// Scheduler — enqueues a poll job for every active agent whose configured
// daily_run_at matches the current minute in its workspace timezone.
//
// Designed to be invoked once per minute, either by:
//   - the worker process's internal interval (worker/index.ts), or
//   - an external cron hitting /api/cron/daily-poll (Vercel Cron, etc.).
// Idempotent: the poll job id is keyed to agent + local date + run time.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getPollQueue } from "@/lib/queue/queues";
import { nowHHMMInTz, todayInTz } from "./cadence";
import type { Agent, AgentCallConfig, Workspace } from "@/types";

export async function tickScheduler(): Promise<{ enqueued: string[] }> {
  const supabase = createServiceClient();
  const enqueued: string[] = [];

  const { data: agents } = await supabase
    .from("agents")
    .select("id, workspace_id, status, direction")
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<Pick<Agent, "id" | "workspace_id" | "status" | "direction">[]>();
  if (!agents?.length) return { enqueued };

  const queue = getPollQueue();

  for (const agent of agents) {
    const { data: config } = await supabase
      .from("agent_call_configs").select("daily_run_at").eq("agent_id", agent.id)
      .single<Pick<AgentCallConfig, "daily_run_at">>();
    const { data: workspace } = await supabase
      .from("workspaces").select("timezone, is_active").eq("id", agent.workspace_id)
      .single<Pick<Workspace, "timezone" | "is_active">>();
    if (!config || !workspace?.is_active) continue;

    // Fire at the FIRST tick at or after daily_run_at, not only on an exact
    // minute match. A single skipped minute (worker restart, GC pause, cron
    // jitter) previously meant the agent never polled that day. The per-day
    // jobId keeps this idempotent: once the poll is enqueued for today, every
    // later tick that day is a no-op (BullMQ ignores the duplicate jobId).
    const now = nowHHMMInTz(workspace.timezone);
    if (now < config.daily_run_at) continue;

    // Skip if this agent's daily poll was already enqueued today. This keeps
    // the catch-up window quiet: we enqueue once at the first tick >= run time
    // and every later tick that day is a no-op instead of re-logging.
    const today = todayInTz(workspace.timezone);
    const jobId = `poll:${agent.id}:${today}`;
    const existing = await queue.getJob(jobId);
    if (existing) continue;

    await queue.add("poll", { agentId: agent.id }, { jobId }); // one poll per agent per day
    enqueued.push(agent.id);
  }

  return { enqueued };
}
