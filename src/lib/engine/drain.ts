// Postgres-backed dial drain for Vercel failover when the Railway worker is down.
// Reads due call_queue_entries, claims rows atomically, and calls placeCall directly
// (no Redis). The worker heartbeat gate prevents double-dialing under normal ops.
import { createServiceClient } from "@/lib/supabase/server";
import { placeCall, OutsideCallWindowError } from "./caller";
import {
  claimQueueEntry,
  revertQueueClaim,
  failQueueEntry,
  countDialedTodayForAgent,
} from "./call-queue";
import { evaluateDialWindow } from "./cadence";
import { remainingDailyDialBudget } from "./rollover-priority";
import type { AgentCallConfig } from "@/types";

type DbClient = ReturnType<typeof createServiceClient>;

interface DueQueueRow {
  id: string;
  agent_id: string;
  contact_id: string;
  workspace_id: string;
  queue_day: string;
  position: number;
  enqueued_at: string | null;
  scheduled_for: string | null;
  contacts: {
    is_terminal: boolean;
    last_called_on: string | null;
    phones: string[];
    attempt_count: number;
  } | null;
    agents: {
    status: string;
    direction: string;
    retell_agent_id: string | null;
    retell_from_number: string | null;
    agent_call_configs:
      | Pick<
          AgentCallConfig,
          | "call_window_start"
          | "call_window_end"
          | "call_window_days"
          | "drip_seconds"
          | "max_calls_per_day"
        >
      | Pick<
          AgentCallConfig,
          | "call_window_start"
          | "call_window_end"
          | "call_window_days"
          | "drip_seconds"
          | "max_calls_per_day"
        >[]
      | null;
  } | null;
  workspaces: { timezone: string; is_active: boolean } | null;
}

export interface DrainResult {
  scanned: number;
  eligible: number;
  wouldDial: number;
  claimed: number;
  dialed: number;
  deferred: number;
  failed: number;
  skipped: number;
}

/** Max dials per agent per 1-minute cron tick, respecting drip spacing. */
export function drainCapacityPerTick(dripSeconds: number): number {
  if (dripSeconds <= 0) return 1;
  return Math.max(1, Math.floor(60 / dripSeconds) + 1);
}

function pickCallConfig(
  raw: DueQueueRow["agents"]
): Pick<
  AgentCallConfig,
  | "call_window_start"
  | "call_window_end"
  | "call_window_days"
  | "drip_seconds"
  | "max_calls_per_day"
> | null {
  const configs = raw?.agent_call_configs;
  if (!configs) return null;
  return Array.isArray(configs) ? configs[0] ?? null : configs;
}

/**
 * Drain due pending queue rows by placing calls directly from Postgres.
 * Intended for Vercel cron when the Railway worker heartbeat is stale.
 */
export async function drainDueDials(opts?: {
  limit?: number;
  dryRun?: boolean;
  db?: DbClient;
}): Promise<DrainResult> {
  const limit = opts?.limit ?? 500;
  const supabase = opts?.db ?? createServiceClient();
  const nowIso = new Date().toISOString();

  const { data: rows, error } = await supabase
    .from("call_queue_entries")
    .select(
      `id, agent_id, contact_id, workspace_id, queue_day, position, enqueued_at, scheduled_for,
       contacts(is_terminal, last_called_on, phones, attempt_count),
       agents(status, direction, retell_agent_id, retell_from_number,
         agent_call_configs(call_window_start, call_window_end, call_window_days, drip_seconds, max_calls_per_day)),
       workspaces(timezone, is_active)`
    )
    .eq("status", "pending")
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order("agent_id", { ascending: true })
    .order("queue_day", { ascending: true })
    .order("position", { ascending: true })
    .order("enqueued_at", { ascending: true })
    .limit(limit)
    .returns<DueQueueRow[]>();

  if (error) throw new Error(error.message);
  if (!rows?.length) {
    return { scanned: 0, eligible: 0, wouldDial: 0, claimed: 0, dialed: 0, deferred: 0, failed: 0, skipped: 0 };
  }

  const result: DrainResult = {
    scanned: rows.length,
    eligible: 0,
    wouldDial: 0,
    claimed: 0,
    dialed: 0,
    deferred: 0,
    failed: 0,
    skipped: 0,
  };

  const perAgentTickBudget = new Map<string, number>();
  const perAgentDailyRemaining = new Map<string, number>();

  for (const row of rows) {
    const agent = row.agents;
    const workspace = row.workspaces;
    const contact = row.contacts;
    const config = pickCallConfig(agent);

    if (
      !agent ||
      agent.status !== "active" ||
      agent.direction !== "outbound" ||
      !agent.retell_agent_id ||
      !agent.retell_from_number ||
      !workspace?.is_active ||
      !config ||
      !contact ||
      contact.is_terminal ||
      !contact.phones?.length
    ) {
      result.skipped++;
      continue;
    }

    const decision = evaluateDialWindow(
      workspace.timezone,
      config.call_window_start,
      config.call_window_end,
      config.call_window_days
    );
    if (!decision.allowed) {
      result.skipped++;
      continue;
    }

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: workspace.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    if (contact.last_called_on === today) {
      result.skipped++;
      continue;
    }

    if (!perAgentDailyRemaining.has(row.agent_id)) {
      const dialedToday = await countDialedTodayForAgent(
        supabase,
        row.agent_id,
        workspace.timezone
      );
      perAgentDailyRemaining.set(
        row.agent_id,
        remainingDailyDialBudget(config.max_calls_per_day, dialedToday)
      );
    }
    const dailyRemaining = perAgentDailyRemaining.get(row.agent_id) ?? 0;
    if (dailyRemaining <= 0) {
      result.skipped++;
      continue;
    }

    const tickCapacity = drainCapacityPerTick(config.drip_seconds);
    const tickUsed = perAgentTickBudget.get(row.agent_id) ?? 0;
    if (tickUsed >= tickCapacity) {
      result.skipped++;
      continue;
    }

    result.eligible++;
    if (opts?.dryRun) {
      result.wouldDial++;
      perAgentTickBudget.set(row.agent_id, tickUsed + 1);
      perAgentDailyRemaining.set(row.agent_id, dailyRemaining - 1);
      continue;
    }

    const claimed = await claimQueueEntry(supabase, { id: row.id });
    if (!claimed) {
      result.skipped++;
      continue;
    }
    result.claimed++;
    perAgentTickBudget.set(row.agent_id, tickUsed + 1);
    perAgentDailyRemaining.set(row.agent_id, dailyRemaining - 1);

    try {
      await placeCall({
        agentId: row.agent_id,
        contactId: row.contact_id,
        toNumber: contact.phones[0],
        attemptNumber: contact.attempt_count + 1,
      });
      result.dialed++;
    } catch (err) {
      if (err instanceof OutsideCallWindowError) {
        const scheduledFor = new Date(Date.now() + err.deferMs).toISOString();
        await revertQueueClaim(supabase, { id: row.id, scheduledFor });
        result.deferred++;
        continue;
      }

      await revertQueueClaim(supabase, { id: row.id });
      await failQueueEntry(supabase, {
        agentId: row.agent_id,
        contactId: row.contact_id,
        errorMessage: err instanceof Error ? err.message : "drain dial failed",
      });
      result.failed++;
    }
  }

  return result;
}
