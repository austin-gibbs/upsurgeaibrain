// =====================================================================
// Poller — the n8n "Call Initiator (WF1)" replacement.
//
// For one agent: pull enrolled contacts from the CRM, reconcile them into
// our `contacts` cache, filter for eligibility, and enqueue one `call` job
// per eligible contact with a drip-throttle delay so dials are spaced out.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { getCallQueue, addCallJobsBulk, closeCallQueue, type CallJobSpec } from "@/lib/queue/queues";
import { getRedis } from "@/lib/queue/connection";
import {
  isEligible,
  isCallDayAllowed,
  isCallWindowClosedForToday,
  msUntilCallWindowOpens,
  remainingWindowCapacity,
  todayInTz,
  evaluateDialWindow,
} from "./cadence";
import type { Agent, AgentCallConfig, AgentTaskConfig, Contact, Workspace } from "@/types";
import {
  upsertQueueEntry,
  countActiveQueueForAgent,
  countRolloverBacklogForAgent,
  listActiveQueuedContactIdsForAgent,
  normalizeRolloverPositions,
  countDialedTodayForAgent,
  reconcileUnenrolledQueueOnPoll,
  stripStaleLocalEnrollTags,
  reconcileZombieDialingRows,
} from "./call-queue";
import { applyPollStageRouting } from "./pipeline-routing";
import { computeNewPollCapacity, excludeActiveQueuedContacts } from "./rollover-priority";
import { buildMergedContactRows, enrolledCrmIds } from "./poller-sync";
import { writePollRun, type PollTriggerSource } from "./poll-runs";
import { buildDialAttempt } from "./enqueue-dial";

export interface PollOptions {
  testMode?: boolean;
  skipRedis?: boolean;
  triggerSource?: PollTriggerSource;
}

export interface PollResult {
  agentId: string;
  scanned: number;
  eligible: number;
  enqueued: number;
  cancelled?: number;
  tagsStripped?: number;
  skippedReason?: string;
}

async function finishPoll(
  supabase: ReturnType<typeof createServiceClient>,
  params: {
    workspaceId: string;
    agentId: string;
    result: PollResult;
    options?: PollOptions;
    tagsStripped?: number;
  }
): Promise<PollResult> {
  const result = {
    ...params.result,
    tagsStripped: params.tagsStripped ?? params.result.tagsStripped,
  };
  await writePollRun(supabase, {
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    result,
    triggerSource: params.options?.triggerSource ?? "worker",
    testMode: params.options?.testMode,
    tagsStripped: params.tagsStripped,
  });
  return result;
}

export async function pollAgent(
  agentId: string,
  options?: PollOptions
): Promise<PollResult> {
  const supabase = createServiceClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single<Agent>();
  if (!agent) return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "agent not found" };
  if (agent.direction === "inbound") {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "inbound agent" };
  }
  if (agent.status !== "active") {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: `agent ${agent.status}` };
  }

  const { data: config } = await supabase
    .from("agent_call_configs")
    .select("*")
    .eq("agent_id", agentId)
    .single<AgentCallConfig>();
  if (!config) return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "no call config" };

  const { data: taskConfig } = await supabase
    .from("agent_task_configs")
    .select("*")
    .eq("agent_id", agentId)
    .maybeSingle<AgentTaskConfig>();

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", agent.workspace_id)
    .single<Workspace>();
  if (!workspace || !workspace.is_active) {
    return { agentId, scanned: 0, eligible: 0, enqueued: 0, skippedReason: "workspace inactive" };
  }

  if (
    !options?.testMode &&
    isCallWindowClosedForToday(
      workspace.timezone,
      config.call_window_end,
      config.call_window_days
    )
  ) {
    return {
      agentId,
      scanned: 0,
      eligible: 0,
      enqueued: 0,
      skippedReason: isCallDayAllowed(workspace.timezone, config.call_window_days)
        ? "call window closed for today"
        : "not a call day",
    };
  }

  const today = todayInTz(workspace.timezone);
  const crm = getCrmAdapterForAgent(agent, workspace);

  // Clear zombie dialing rows before capacity math so rollover backlog is accurate.
  await reconcileZombieDialingRows(supabase, { agentId }).catch((err) => {
    console.error(`[poll] zombie dialing cleanup failed for agent ${agentId}:`, err);
  });

  // 1. Pull everyone carrying this agent's enroll tag (falls back to workspace tag).
  const enrollTag = agent.enroll_tag ?? workspace.enroll_tag;
  const crmContacts = await crm.getContactsByTag(enrollTag);
  const scannedCrmIds = enrolledCrmIds(crmContacts);

  // 2. Upsert into our cache, preserving cadence state we already track.
  const crmIds = crmContacts.map((c) => c.id);
  const existingByCrmId = new Map<string, Contact>();

  if (crmIds.length > 0) {
    const { data: existingRows } = await supabase
      .from("contacts")
      .select("*")
      .eq("workspace_id", workspace.id)
      .in("crm_contact_id", crmIds)
      .returns<Contact[]>();
    for (const row of existingRows ?? []) {
      existingByCrmId.set(row.crm_contact_id, row);
    }
  }

  const mergedRows = buildMergedContactRows(crmContacts, existingByCrmId, workspace.id);

  const contacts: Contact[] = [];
  if (mergedRows.length > 0) {
    const { data: savedRows } = await supabase
      .from("contacts")
      .upsert(mergedRows, { onConflict: "workspace_id,crm_contact_id" })
      .select("*")
      .returns<Contact[]>();
    if (savedRows) contacts.push(...savedRows);
  }

  // 2a. Strip enroll tag locally for contacts no longer returned by CRM scan.
  let tagsStripped = 0;
  try {
    tagsStripped = await stripStaleLocalEnrollTags(supabase, {
      workspaceId: workspace.id,
      enrollTag,
      enrolledCrmContactIds: scannedCrmIds,
    });
  } catch (err) {
    console.error(`[poll] strip stale enroll tags failed for agent ${agentId}:`, err);
    return finishPoll(supabase, {
      workspaceId: workspace.id,
      agentId,
      options,
      tagsStripped,
      result: {
        agentId,
        scanned: contacts.length,
        eligible: 0,
        enqueued: 0,
        skippedReason: "stale_tag_refresh_failed",
      },
    });
  }

  // 2b. Drop pending queue rows for contacts no longer enrolled in CRM.
  const enrolledContactIds = new Set(contacts.map((c) => c.id));
  let cancelled = 0;
  try {
    cancelled = await reconcileUnenrolledQueueOnPoll(supabase, {
      agentId,
      enrolledContactIds,
      skipRedis: options?.skipRedis,
    });
  } catch (err) {
    console.error(`[poll] reconcile unenrolled queue failed for agent ${agentId}:`, err);
    return finishPoll(supabase, {
      workspaceId: workspace.id,
      agentId,
      options,
      tagsStripped,
      result: {
        agentId,
        scanned: contacts.length,
        eligible: 0,
        enqueued: 0,
        cancelled,
        tagsStripped,
        skippedReason: "reconcile_failed",
      },
    });
  }

  // 3. Filter eligible, sort for fair rollover, cap to what fits today's window.
  const eligible = contacts
    .filter((c) => isEligible(c, config, today) && c.phones.length > 0)
    .sort((a, b) => {
      const na = a.next_eligible_on ?? "0000-00-00";
      const nb = b.next_eligible_on ?? "0000-00-00";
      if (na !== nb) return na.localeCompare(nb);
      return a.attempt_count - b.attempt_count;
    });

  await normalizeRolloverPositions(supabase, agentId, today).catch(() => {});

  const rolloverBacklog = await countRolloverBacklogForAgent(supabase, agentId, today);
  const activeQueuedIds = await listActiveQueuedContactIdsForAgent(supabase, agentId);
  const eligibleNotQueued = excludeActiveQueuedContacts(eligible, activeQueuedIds);

  const windowCapacity = options?.testMode
    ? config.max_calls_per_day
    : remainingWindowCapacity(
        workspace.timezone,
        config.call_window_start,
        config.call_window_end,
        config.drip_seconds,
        config.call_window_days
      );
  const dailyCap = Math.min(config.max_calls_per_day, windowCapacity);
  const newCallCapacity = computeNewPollCapacity(dailyCap, rolloverBacklog);

  if (newCallCapacity === 0 && eligibleNotQueued.length > 0) {
    return finishPoll(supabase, {
      workspaceId: workspace.id,
      agentId,
      options,
      tagsStripped,
      result: {
        agentId,
        scanned: contacts.length,
        eligible: eligible.length,
        enqueued: 0,
        cancelled,
        tagsStripped,
        skippedReason: "capacity reserved for rollover backlog",
      },
    });
  }

  const capped = eligibleNotQueued.slice(0, newCallCapacity);

  // 3b. HighLevel poll-stage routing — move only contacts we are about to queue.
  if (taskConfig?.poll_stage_enabled && capped.length > 0) {
    try {
      await applyPollStageRouting({ crm, contacts: capped, taskConfig });
    } catch {
      /* non-fatal: never block poll on a pipeline move */
    }
  }

  const baseDelay = options?.testMode
    ? 0
    : msUntilCallWindowOpens(
        workspace.timezone,
        config.call_window_start,
        config.call_window_end,
        config.call_window_days
      );

  // 4. Persist queue rows, then bulk-enqueue dial jobs (one Redis round-trip).
  const jobSpecs: CallJobSpec[] = [];
  for (let i = 0; i < capped.length; i++) {
    const contact = capped[i];
    const delay = baseDelay + i * config.drip_seconds * 1000;
    const baseJobId = `${agentId}:${contact.id}:${today}`;
    const scheduledFor = new Date(Date.now() + delay).toISOString();

    const attempt = buildDialAttempt({
      agent,
      workspace,
      contact,
      agentId,
      baseJobId,
      queueDay: today,
      testMode: options?.testMode,
    });
    if (!attempt) continue;

    const queueEntryId = await upsertQueueEntry(supabase, {
      workspaceId: workspace.id,
      agentId,
      contactId: contact.id,
      queueDay: today,
      position: rolloverBacklog + i + 1,
      scheduledFor,
      bullmqJobId: attempt.jobId,
      attemptNumber: attempt.attemptNumber,
      phoneNumbers: attempt.phoneNumbers,
      nextPhoneIndex: attempt.phoneIndex,
    });

    jobSpecs.push({
      delay,
      jobId: attempt.jobId,
      data: {
        ...attempt.jobData,
        queueEntryId,
      },
    });
  }

  let enqueued = 0;
  if (jobSpecs.length > 0 && process.env.REDIS_URL && !options?.skipRedis) {
    try {
      await addCallJobsBulk(jobSpecs);
      enqueued = jobSpecs.length;
    } catch {
      // Durable queue rows remain; worker sweeper will enqueue if Redis failed.
      enqueued = jobSpecs.length;
    }
  } else if (jobSpecs.length > 0) {
    // No Redis on this host (Vercel manual poll) — rows are the source of truth.
    enqueued = jobSpecs.length;
  }

  return finishPoll(supabase, {
    workspaceId: workspace.id,
    agentId,
    options,
    tagsStripped,
    result: { agentId, scanned: contacts.length, eligible: eligible.length, enqueued, cancelled, tagsStripped },
  });
}

export interface QueueContactsResult {
  agentId: string;
  requested: number;
  eligible: number;
  enqueued: number;
  capped: number;
  errors?: string[];
  skippedReason?: string;
}

/**
 * Manually enqueue a hand-picked set of contacts into the live call queue
 * right now, drip-spaced at the agent's `drip_seconds`. This is the engine
 * behind the Ops "Queue calls now" bulk action.
 *
 * Unlike the poller it does NOT scan the CRM and deliberately bypasses the
 * cadence "already called today / not yet due" gate — the operator is pulling
 * these contacts back in on purpose. It still honors the hard safety rails:
 * terminal contacts and contacts without a phone are dropped. The operator
 * explicitly selected these contacts — we queue all of them (drip-spaced)
 * and let the worker defer dials outside the call window. Only the daily
 * max_calls_per_day cap can trim the batch.
 */
export async function enqueueContactsNow(
  agentId: string,
  contactIds: string[]
): Promise<QueueContactsResult> {
  const supabase = createServiceClient();
  const requested = contactIds.length;
  const base = { agentId, requested, eligible: 0, enqueued: 0, capped: 0 };

  const { data: agent } = await supabase
    .from("agents").select("*").eq("id", agentId).single<Agent>();
  if (!agent) return { ...base, skippedReason: "agent not found" };
  if (agent.direction === "inbound") return { ...base, skippedReason: "inbound agent" };
  if (agent.status !== "active") return { ...base, skippedReason: `agent ${agent.status}` };
  if (!agent.retell_agent_id || !agent.retell_from_number) {
    return { ...base, skippedReason: "agent missing Retell linkage" };
  }

  const { data: config } = await supabase
    .from("agent_call_configs").select("*").eq("agent_id", agentId).single<AgentCallConfig>();
  if (!config) return { ...base, skippedReason: "no call config" };

  const { data: workspace } = await supabase
    .from("workspaces").select("*").eq("id", agent.workspace_id).single<Workspace>();
  if (!workspace || !workspace.is_active) {
    return { ...base, skippedReason: "workspace inactive" };
  }

  const windowDecision = evaluateDialWindow(
    workspace.timezone,
    config.call_window_start,
    config.call_window_end,
    config.call_window_days
  );
  if (!windowDecision.allowed) {
    return { ...base, skippedReason: windowDecision.reason };
  }

  const today = todayInTz(workspace.timezone);

  const { data: rows } = await supabase
    .from("contacts")
    .select("*")
    .eq("workspace_id", workspace.id)
    .in("id", contactIds)
    .returns<Contact[]>();

  // Preserve the operator's selection order.
  const byId = new Map((rows ?? []).map((c) => [c.id, c]));
  const dialable = contactIds
    .map((id) => byId.get(id))
    .filter((c): c is Contact => {
      if (!c) return false;
      return !c.is_terminal && c.phones.length > 0;
    });
  const eligible = dialable.length;

  const activeInQueue = await countActiveQueueForAgent(supabase, agentId, today);
  const basePosition = activeInQueue;

  // Queue every dialable contact the operator selected. Drip spacing continues
  // from any contacts already waiting; the worker defers dials outside the window.
  const toQueue = dialable;
  const capped = contactIds.length - eligible;

  const jobSpecs: CallJobSpec[] = [];
  const errors: string[] = [];

  // 1. Persist all queue rows first so the Ops UI reflects the full batch
  // even if Redis is slow or partially fails.
  for (let i = 0; i < toQueue.length; i++) {
    const contact = toQueue[i];
    const slot = basePosition + i;
    const delay = slot * config.drip_seconds * 1000;
    const baseJobId = `manual:${agentId}:${contact.id}:${today}`;
    const scheduledFor = new Date(Date.now() + delay).toISOString();

    try {
      const attempt = buildDialAttempt({
        agent,
        workspace,
        contact,
        agentId,
        baseJobId,
        queueDay: today,
      });
      if (!attempt) continue;

      const queueEntryId = await upsertQueueEntry(supabase, {
        workspaceId: workspace.id,
        agentId,
        contactId: contact.id,
        queueDay: today,
        position: slot + 1,
        scheduledFor,
        bullmqJobId: attempt.jobId,
        attemptNumber: attempt.attemptNumber,
        phoneNumbers: attempt.phoneNumbers,
        nextPhoneIndex: attempt.phoneIndex,
      });
      jobSpecs.push({
        delay,
        jobId: attempt.jobId,
        data: {
          ...attempt.jobData,
          queueEntryId,
        },
      });
    } catch (e) {
      errors.push(
        `${contact.full_name ?? contact.id}: ${
          e instanceof Error ? e.message : "failed to save queue row"
        }`
      );
    }
  }

  // 2. One Redis round-trip for every dial job (avoids serverless hang).
  let enqueued = 0;
  if (jobSpecs.length > 0 && process.env.REDIS_URL) {
    try {
      const queue = getCallQueue();
      await getRedis().connect();
      // Drop any scheduled poll jobs for these contacts so manual queue
      // doesn't double-dial alongside today's poll batch.
      for (const contact of toQueue) {
        const pollJobId = `${agentId}:${contact.id}:${today}`;
        const pollJob = await queue.getJob(pollJobId);
        if (pollJob) await pollJob.remove().catch(() => {});
      }
      await addCallJobsBulk(jobSpecs);
      enqueued = jobSpecs.length;
    } catch (e) {
      errors.push(
        e instanceof Error ? e.message : "failed to enqueue dial jobs in Redis"
      );
      // Roll back rows that would never dial — avoids ghost entries in the UI.
      for (const spec of jobSpecs) {
        await supabase
          .from("call_queue_entries")
          .delete()
          .eq("agent_id", agentId)
          .eq("contact_id", spec.data.contactId)
          .eq("queue_day", today)
          .eq("status", "pending");
      }
    } finally {
      await closeCallQueue().catch(() => {});
    }
  } else if (jobSpecs.length > 0 && !process.env.REDIS_URL) {
    // No Redis on this tier (e.g. Vercel serverless, where the Ops "Queue
    // calls now" button runs and Railway's private Redis is unreachable).
    // Leave the durable call_queue_entries rows in place — the worker's
    // self-heal sweeper enqueues them into Redis on its next tick and the call
    // worker dials them. The durable table is the source of truth, so this is a
    // success, not a failure: do NOT roll the rows back.
    enqueued = jobSpecs.length;
  }

  return { agentId, requested, eligible, enqueued, capped, errors: errors.length ? errors : undefined };
}

/** Run async tasks with a bounded concurrency pool. */
async function mapWithConcurrency<T, R>(
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

/** Poll every active outbound agent in a workspace. */
export async function pollWorkspace(
  workspaceId: string,
  options?: PollOptions
): Promise<PollResult[]> {
  try {
    const supabase = createServiceClient();
    const { data: agents } = await supabase
      .from("agents")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("status", "active")
      .eq("direction", "outbound")
      .returns<{ id: string }[]>();

    if (!agents?.length) return [];

    return mapWithConcurrency(agents, 4, (agent) =>
      pollAgent(agent.id, { ...options, triggerSource: options?.triggerSource ?? "manual" })
    );
  } finally {
    // Release Redis so serverless poll handlers can exit (avoids timeout hang).
    await closeCallQueue().catch(() => {});
  }
}
