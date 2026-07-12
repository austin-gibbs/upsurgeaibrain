// Failover poll runner — bounded concurrency + per-agent timeout so one slow
// CRM scan cannot monopolize the Vercel cron window.
import { createServiceClient } from "@/lib/supabase/server";
import { pollAgent, type PollOptions, type PollResult } from "./poller";
import { isAgentEligibleForPollTick } from "./poll-schedule";
import {
  agentLacksRecentPollCoverage,
  shouldPollAgentInFailover,
} from "./poll-coverage";
import type { Agent, AgentCallConfig } from "@/types";

type DbClient = ReturnType<typeof createServiceClient>;

export type PollFallbackAgentRow = Pick<Agent, "id" | "status" | "direction" | "workspace_id"> & {
  agent_call_configs:
    | Pick<
        AgentCallConfig,
        | "daily_run_at"
        | "call_window_start"
        | "call_window_end"
        | "call_window_days"
      >
    | Pick<
        AgentCallConfig,
        | "daily_run_at"
        | "call_window_start"
        | "call_window_end"
        | "call_window_days"
      >[]
    | null;
  workspaces: { timezone: string; is_active: boolean } | null;
};

function pickConfig(agent: PollFallbackAgentRow) {
  return Array.isArray(agent.agent_call_configs)
    ? agent.agent_call_configs[0]
    : agent.agent_call_configs;
}

export interface PollFallbackCandidate {
  agentId: string;
  lacksPollCoverage: boolean;
}

/** Classify which agents should be polled and prioritize coverage gaps. */
export async function selectPollFallbackCandidates(
  agents: PollFallbackAgentRow[],
  infrastructureFailover: boolean,
  db: DbClient
): Promise<PollFallbackCandidate[]> {
  const eligible: PollFallbackCandidate[] = [];

  for (const agent of agents) {
    const config = pickConfig(agent);
    const workspace = agent.workspaces;
    if (!config?.daily_run_at || !workspace?.is_active) continue;

    const pollTickEligible = isAgentEligibleForPollTick({
      timezone: workspace.timezone,
      dailyRunAt: config.daily_run_at,
      callWindowStart: config.call_window_start,
      callWindowEnd: config.call_window_end,
      callWindowDays: config.call_window_days,
    });
    const lacksPollCoverage = await agentLacksRecentPollCoverage(agent.id, {
      db,
    });

    if (
      !shouldPollAgentInFailover({
        infrastructureFailover,
        pollTickEligible,
        lacksPollCoverage,
      })
    ) {
      continue;
    }

    eligible.push({ agentId: agent.id, lacksPollCoverage });
  }

  eligible.sort((a, b) => {
    if (a.lacksPollCoverage !== b.lacksPollCoverage) {
      return a.lacksPollCoverage ? -1 : 1;
    }
    return a.agentId.localeCompare(b.agentId);
  });

  return eligible;
}

export const POLL_FAILOVER_CONCURRENCY = 4;
export const POLL_FAILOVER_AGENT_TIMEOUT_MS = 25_000;

export class PollAgentTimeoutError extends Error {
  readonly agentId: string;
  constructor(agentId: string, timeoutMs: number) {
    super(`poll timed out for agent ${agentId} after ${timeoutMs}ms`);
    this.name = "PollAgentTimeoutError";
    this.agentId = agentId;
  }
}

export interface PollFailoverAgentResult {
  agentId: string;
  ok: boolean;
  result?: PollResult;
  error?: string;
  timedOut?: boolean;
}

/** Run async tasks with a bounded concurrency pool. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

export async function pollAgentWithTimeout(
  agentId: string,
  options: PollOptions,
  timeoutMs: number = POLL_FAILOVER_AGENT_TIMEOUT_MS
): Promise<PollResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PollAgentTimeoutError(agentId, timeoutMs)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([pollAgent(agentId, options), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Poll many agents in parallel with per-agent timeouts. Errors and timeouts are
 * isolated so every eligible agent gets a chance within the cron budget.
 */
export async function runPollFailoverBatch(
  agentIds: string[],
  options: PollOptions,
  opts?: { concurrency?: number; timeoutMs?: number }
): Promise<PollFailoverAgentResult[]> {
  const concurrency = opts?.concurrency ?? POLL_FAILOVER_CONCURRENCY;
  const timeoutMs = opts?.timeoutMs ?? POLL_FAILOVER_AGENT_TIMEOUT_MS;

  return mapWithConcurrency(agentIds, concurrency, async (agentId) => {
    try {
      const result = await pollAgentWithTimeout(agentId, options, timeoutMs);
      return { agentId, ok: true, result };
    } catch (e) {
      const timedOut = e instanceof PollAgentTimeoutError;
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `[poll-fallback] agent ${agentId} ${timedOut ? "timed out" : "failed"}: ${message}`
      );
      return { agentId, ok: false, error: message, timedOut };
    }
  });
}
