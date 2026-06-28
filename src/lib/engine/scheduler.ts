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

type SchedulerAgentRow = Pick<Agent, "id" | "workspace_id" | "status" | "direction"> & {
  agent_call_configs:
    | Pick<AgentCallConfig, "daily_run_at">
    | Pick<AgentCallConfig, "daily_run_at">[]
    | null;
  workspaces: Pick<Workspace, "timezone" | "is_active"> | null;
};

function pickDailyRunAt(row: SchedulerAgentRow): string | null {
  const configs = row.agent_call_configs;
  if (!configs) return null;
  const config = Array.isArray(configs) ? configs[0] : configs;
  return config?.daily_run_at ?? null;
}

export async function tickScheduler(): Promise<{ enqueued: string[] }> {
  const supabase = createServiceClient();
  const enqueued: string[] = [];

  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, workspace_id, status, direction,
       agent_call_configs(daily_run_at),
       workspaces(timezone, is_active)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<SchedulerAgentRow[]>();
  if (!agents?.length) return { enqueued };

  const queue = getPollQueue();
  const candidates: { agentId: string; jobId: string }[] = [];

  for (const agent of agents) {
    const dailyRunAt = pickDailyRunAt(agent);
    const workspace = agent.workspaces;
    if (!dailyRunAt || !workspace?.is_active) continue;

    const now = nowHHMMInTz(workspace.timezone);
    if (now < dailyRunAt) continue;

    const today = todayInTz(workspace.timezone);
    candidates.push({ agentId: agent.id, jobId: `poll:${agent.id}:${today}` });
  }

  if (!candidates.length) return { enqueued };

  const existingJobs = await Promise.all(
    candidates.map(async (c) => ({
      ...c,
      exists: Boolean(await queue.getJob(c.jobId)),
    }))
  );

  for (const candidate of existingJobs) {
    if (candidate.exists) continue;
    await queue.add("poll", { agentId: candidate.agentId }, { jobId: candidate.jobId });
    enqueued.push(candidate.agentId);
  }

  return { enqueued };
}
