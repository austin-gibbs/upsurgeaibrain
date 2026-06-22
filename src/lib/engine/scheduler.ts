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

    const now = nowHHMMInTz(workspace.timezone);
    if (now !== config.daily_run_at) continue;

    const today = todayInTz(workspace.timezone);
    await queue.add(
      "poll",
      { agentId: agent.id },
      { jobId: `poll:${agent.id}:${today}` } // one poll per agent per day
    );
    enqueued.push(agent.id);
  }

  return { enqueued };
}
