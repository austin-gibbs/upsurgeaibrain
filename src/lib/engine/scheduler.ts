// =====================================================================
// Scheduler — enqueues a poll job for every active outbound agent that is
// inside its configured calling window.
//
// Designed to be invoked once per minute, either by:
//   - the worker process's internal interval (worker/index.ts), or
//   - an external cron hitting /api/cron/daily-poll (Vercel Cron, etc.).
// Idempotent: poll job ids are keyed to agent + local date + 2-minute bucket,
// so ticks at 09:00 and 09:01 share one job while 09:02 gets the next.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getPollQueue } from "@/lib/queue/queues";
import {
  buildPollJobId,
  isAgentEligibleForPollTick,
  pollJobBucketForTimezone,
} from "./poll-schedule";
import type { Agent, AgentCallConfig, Workspace } from "@/types";

type SchedulerAgentRow = Pick<Agent, "id" | "workspace_id" | "status" | "direction"> & {
  agent_call_configs:
    | Pick<
        AgentCallConfig,
        "daily_run_at" | "call_window_start" | "call_window_end" | "call_window_days"
      >
    | Pick<
        AgentCallConfig,
        "daily_run_at" | "call_window_start" | "call_window_end" | "call_window_days"
      >[]
    | null;
  workspaces: Pick<Workspace, "timezone" | "is_active"> | null;
};

function pickCallConfig(row: SchedulerAgentRow) {
  const configs = row.agent_call_configs;
  if (!configs) return null;
  return Array.isArray(configs) ? configs[0] : configs;
}

export async function tickScheduler(): Promise<{ enqueued: string[] }> {
  const supabase = createServiceClient();
  const enqueued: string[] = [];

  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, workspace_id, status, direction,
       agent_call_configs(daily_run_at, call_window_start, call_window_end, call_window_days),
       workspaces(timezone, is_active)`
    )
    .eq("status", "active")
    .eq("direction", "outbound")
    .returns<SchedulerAgentRow[]>();
  if (!agents?.length) return { enqueued };

  const queue = getPollQueue();
  const candidates: { agentId: string; jobId: string }[] = [];

  for (const agent of agents) {
    const config = pickCallConfig(agent);
    const workspace = agent.workspaces;
    if (!config?.daily_run_at || !workspace?.is_active) continue;

    if (
      !isAgentEligibleForPollTick({
        timezone: workspace.timezone,
        dailyRunAt: config.daily_run_at,
        callWindowStart: config.call_window_start,
        callWindowEnd: config.call_window_end,
        callWindowDays: config.call_window_days,
      })
    ) {
      continue;
    }

    const { today, bucket } = pollJobBucketForTimezone(workspace.timezone);
    candidates.push({
      agentId: agent.id,
      jobId: buildPollJobId(agent.id, today, bucket),
    });
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
