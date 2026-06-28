// =====================================================================
// Call-queue self-heal.
//
// The durable source of truth for "who should be dialed today" is the
// `call_queue_entries` table (Postgres). The BullMQ delayed-job set in Redis
// is just the execution layer. Those two can drift apart when:
//   - the worker is redeployed/restarted mid-window (jobs killed/stalled),
//   - the Redis instance restarts without persistence (delayed jobs lost),
//   - an enqueue wrote the durable row but the Redis push failed.
//
// When that happens, dialing silently stops even though the queue rows still
// exist. This sweeper re-aligns Redis to Postgres: for every `pending` row that
// is due now and has no live BullMQ job, it re-enqueues a drip-spaced dial job.
//
// It is idempotent: rows whose job still exists are skipped (BullMQ also
// ignores duplicate jobIds), terminal/phoneless/already-dialed contacts are
// dropped, and the call worker re-checks the call window before placing a call.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCallQueue } from "./queues";
import { msUntilQueueSlot, todayInTz } from "@/lib/engine/cadence";
import type { AgentCallConfig } from "@/types";

type DbClient = ReturnType<typeof createServiceClient>;

interface PendingRow {
  id: string;
  agent_id: string;
  contact_id: string;
  workspace_id: string;
  queue_day: string;
  position: number;
  scheduled_for: string | null;
  bullmq_job_id: string | null;
}

interface AgentDial {
  config: AgentCallConfig;
  timezone: string;
}

export interface SweepResult {
  scanned: number;
  reEnqueued: number;
  skipped: number;
}

export function isLiveBullMqState(state: string): boolean {
  return ["waiting", "delayed", "active", "prioritized", "paused", "waiting-children"].includes(state);
}

async function loadAgentDial(
  supabase: DbClient,
  cache: Map<string, AgentDial | null>,
  agentId: string,
  workspaceId: string
): Promise<AgentDial | null> {
  if (cache.has(agentId)) return cache.get(agentId) ?? null;

  const { data: agent } = await supabase
    .from("agents")
    .select("status, direction")
    .eq("id", agentId)
    .single<{ status: string; direction: string }>();

  if (!agent || agent.status !== "active" || agent.direction !== "outbound") {
    cache.set(agentId, null);
    return null;
  }

  const { data: config } = await supabase
    .from("agent_call_configs")
    .select("*")
    .eq("agent_id", agentId)
    .single<AgentCallConfig>();
  if (!config) {
    cache.set(agentId, null);
    return null;
  }

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("timezone, is_active")
    .eq("id", workspaceId)
    .single<{ timezone: string; is_active: boolean }>();
  if (!workspace || !workspace.is_active) {
    cache.set(agentId, null);
    return null;
  }

  const dial: AgentDial = { config, timezone: workspace.timezone };
  cache.set(agentId, dial);
  return dial;
}

/**
 * Re-enqueue dial jobs for durable pending queue rows that have lost their
 * BullMQ job. Returns counts for logging.
 */
export async function resyncCallQueue(opts?: { limit?: number }): Promise<SweepResult> {
  if (!process.env.REDIS_URL) return { scanned: 0, reEnqueued: 0, skipped: 0 };

  const limit = opts?.limit ?? 1000;
  const supabase = createServiceClient();
  const nowIso = new Date().toISOString();

  // Only rows that should already be runnable: no future schedule. Future-dated
  // rows keep their existing delayed job and are left alone.
  const { data: rows } = await supabase
    .from("call_queue_entries")
    .select(
      "id, agent_id, contact_id, workspace_id, queue_day, position, enqueued_at, scheduled_for, bullmq_job_id"
    )
    .eq("status", "pending")
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .order("agent_id", { ascending: true })
    .order("queue_day", { ascending: true })
    .order("position", { ascending: true })
    .order("enqueued_at", { ascending: true })
    .limit(limit)
    .returns<PendingRow[]>();

  if (!rows?.length) return { scanned: 0, reEnqueued: 0, skipped: 0 };

  const queue = getCallQueue();
  const agentCache = new Map<string, AgentDial | null>();
  // Re-stagger only the jobs we actually rebuild, per agent, so recovered dials
  // keep drip spacing instead of firing in one burst.
  const rebuildIndex = new Map<string, number>();

  let reEnqueued = 0;
  let skipped = 0;

  for (const row of rows) {
    const jobId =
      row.bullmq_job_id ?? `${row.agent_id}:${row.contact_id}:${row.queue_day}`;

    // Already has a live job → nothing to heal. Completed/failed Redis jobs do
    // not count as live; if Postgres still says pending, rebuild the job.
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (isLiveBullMqState(state)) {
        skipped++;
        continue;
      }
      await existing.remove().catch(() => {});
    }

    const dial = await loadAgentDial(
      supabase,
      agentCache,
      row.agent_id,
      row.workspace_id
    );
    if (!dial) {
      skipped++;
      continue;
    }

    // Contact-level safety rails (mirror placeCall + poller).
    const { data: contact } = await supabase
      .from("contacts")
      .select("is_terminal, last_called_on, phones, attempt_count")
      .eq("id", row.contact_id)
      .maybeSingle<{
        is_terminal: boolean;
        last_called_on: string | null;
        phones: string[];
        attempt_count: number;
      }>();

    const today = todayInTz(dial.timezone);
    if (
      !contact ||
      contact.is_terminal ||
      !contact.phones?.length ||
      contact.last_called_on === today
    ) {
      skipped++;
      continue;
    }

    const idx = rebuildIndex.get(row.agent_id) ?? 0;
    rebuildIndex.set(row.agent_id, idx + 1);

    const delay = Math.max(
      msUntilQueueSlot(
        dial.timezone,
        dial.config.call_window_start,
        dial.config.call_window_end,
        dial.config.drip_seconds,
        idx
      ),
      0
    );

    await queue.add(
      "dial",
      {
        agentId: row.agent_id,
        contactId: row.contact_id,
        toNumber: contact.phones[0],
        attemptNumber: contact.attempt_count + 1,
      },
      { delay, jobId }
    );

    await supabase
      .from("call_queue_entries")
      .update({
        scheduled_for: new Date(Date.now() + delay).toISOString(),
        bullmq_job_id: jobId,
      })
      .eq("id", row.id);

    reEnqueued++;
  }

  return { scanned: rows.length, reEnqueued, skipped };
}
