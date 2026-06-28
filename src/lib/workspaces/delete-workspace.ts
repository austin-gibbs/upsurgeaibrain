// =====================================================================
// Workspace deletion — pause agents, drain BullMQ jobs, then hard-delete
// the workspace row (child rows cascade via FK).
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { closeRedis } from "@/lib/queue/connection";
import { getCallQueue, getPollQueue, type CallJob, type PollJob } from "@/lib/queue/queues";

export type WorkspaceDeleteCounts = {
  agents: number;
  contacts: number;
  calls: number;
  queueEntries: number;
};

export type WorkspaceDeletePreview = {
  workspaceId: string;
  workspaceName: string;
  organizationId: string;
  counts: WorkspaceDeleteCounts;
  queueJobs: { poll: number; call: number };
};

export type DeleteWorkspaceResult =
  | ({ ok: true; dryRun: true } & WorkspaceDeletePreview)
  | ({
      ok: true;
      dryRun: false;
      deleted: true;
      agentsPaused: number;
      jobsRemoved: number;
    } & WorkspaceDeletePreview);

type WorkspaceRow = {
  id: string;
  name: string;
  organization_id: string;
};

async function loadWorkspace(
  db: SupabaseClient,
  workspaceId: string
): Promise<WorkspaceRow | null> {
  const { data, error } = await db
    .from("workspaces")
    .select("id, name, organization_id")
    .eq("id", workspaceId)
    .maybeSingle<WorkspaceRow>();
  if (error) throw new Error(error.message);
  return data;
}

async function loadCounts(
  db: SupabaseClient,
  workspaceId: string
): Promise<WorkspaceDeleteCounts> {
  const [agents, contacts, calls, queueEntries] = await Promise.all([
    db
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    db
      .from("calls")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
    db
      .from("call_queue_entries")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
  ]);

  return {
    agents: agents.count ?? 0,
    contacts: contacts.count ?? 0,
    calls: calls.count ?? 0,
    queueEntries: queueEntries.count ?? 0,
  };
}

async function loadAgentIds(db: SupabaseClient, workspaceId: string): Promise<string[]> {
  const { data, error } = await db
    .from("agents")
    .select("id")
    .eq("workspace_id", workspaceId)
    .returns<{ id: string }[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map((a) => a.id);
}

const JOB_STATES = [
  "waiting",
  "delayed",
  "prioritized",
  "paused",
  "active",
] as const;

async function closeQueueConnections(): Promise<void> {
  try {
    const pollQueue = getPollQueue();
    const callQueue = getCallQueue();
    await pollQueue.close();
    await callQueue.close();
  } catch {
    // Queues may not have been opened.
  } finally {
    closeRedis();
  }
}

async function scanQueueJobs(agentIds: Set<string>): Promise<{ poll: number; call: number }> {
  if (!process.env.REDIS_URL || agentIds.size === 0) {
    return { poll: 0, call: 0 };
  }

  let poll = 0;
  let call = 0;
  try {
    const pollQueue = getPollQueue();
    const callQueue = getCallQueue();
    const [pollJobs, callJobs] = await Promise.all([
      pollQueue.getJobs([...JOB_STATES]),
      callQueue.getJobs([...JOB_STATES]),
    ]);

    for (const job of pollJobs) {
      const agentId = (job.data as PollJob | undefined)?.agentId;
      if (agentId && agentIds.has(agentId)) poll++;
    }
    for (const job of callJobs) {
      const agentId = (job.data as CallJob | undefined)?.agentId;
      if (agentId && agentIds.has(agentId)) call++;
    }
  } catch {
    // Redis unavailable — DB delete still proceeds.
  } finally {
    await closeQueueConnections();
  }
  return { poll, call };
}

async function removeQueueJobs(
  agentIds: Set<string>
): Promise<{ removed: number; poll: number; call: number }> {
  if (!process.env.REDIS_URL || agentIds.size === 0) {
    return { removed: 0, poll: 0, call: 0 };
  }

  let removed = 0;
  let poll = 0;
  let call = 0;
  try {
    const pollQueue = getPollQueue();
    const callQueue = getCallQueue();
    const [pollJobs, callJobs] = await Promise.all([
      pollQueue.getJobs([...JOB_STATES]),
      callQueue.getJobs([...JOB_STATES]),
    ]);

    for (const job of pollJobs) {
      const agentId = (job.data as PollJob | undefined)?.agentId;
      if (!agentId || !agentIds.has(agentId)) continue;
      poll++;
      try {
        await job.remove();
        removed++;
      } catch {
        // Job may have started or finished between scan and removal.
      }
    }
    for (const job of callJobs) {
      const agentId = (job.data as CallJob | undefined)?.agentId;
      if (!agentId || !agentIds.has(agentId)) continue;
      call++;
      try {
        await job.remove();
        removed++;
      } catch {
        // Job may have started or finished between scan and removal.
      }
    }

    await pollQueue.close();
    await callQueue.close();
  } catch {
    // Best-effort queue drain.
  } finally {
    closeRedis();
  }

  return { removed, poll, call };
}

/**
 * Hard-delete a workspace and all cascaded data. When dryRun is true, returns
 * counts only. Retell resources (agents, numbers, LLMs) are NOT torn down.
 */
export async function deleteWorkspaceById(
  db: SupabaseClient,
  workspaceId: string,
  options?: { dryRun?: boolean }
): Promise<DeleteWorkspaceResult | null> {
  const workspace = await loadWorkspace(db, workspaceId);
  if (!workspace) return null;

  const agentIds = await loadAgentIds(db, workspaceId);
  const agentIdSet = new Set(agentIds);
  const counts = await loadCounts(db, workspaceId);

  if (options?.dryRun) {
    const queueJobs = await scanQueueJobs(agentIdSet);
    return {
      ok: true,
      dryRun: true,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      organizationId: workspace.organization_id,
      counts,
      queueJobs,
    };
  }

  if (agentIds.length > 0) {
    const { error: pauseErr } = await db
      .from("agents")
      .update({ status: "paused", updated_at: new Date().toISOString() })
      .in("id", agentIds);
    if (pauseErr) throw new Error(pauseErr.message);
  }

  const { removed: jobsRemoved, poll, call } = await removeQueueJobs(agentIdSet);

  const { error: deleteErr } = await db
    .from("workspaces")
    .delete()
    .eq("id", workspaceId);
  if (deleteErr) throw new Error(deleteErr.message);

  return {
    ok: true,
    dryRun: false,
    deleted: true,
    agentsPaused: agentIds.length,
    jobsRemoved,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    organizationId: workspace.organization_id,
    counts,
    queueJobs: { poll, call },
  };
}

/** Resolve a workspace by exact name (newest first, matching console routes). */
export async function findWorkspaceByName(
  db: SupabaseClient,
  name: string
): Promise<WorkspaceRow | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const { data, error } = await db
    .from("workspaces")
    .select("id, name, organization_id")
    .eq("name", trimmed)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<WorkspaceRow>();
  if (error) throw new Error(error.message);
  return data;
}
