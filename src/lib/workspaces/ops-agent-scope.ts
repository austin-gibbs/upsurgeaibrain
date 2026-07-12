// Ops scope helpers: pick which outbound agent the Operations tab focuses
// on in multi-agent workspaces, and remember the operator's last choice.
import {
  contactHasEnrollTag,
  effectiveEnrollTag,
} from "@/lib/agents/enroll-tag";

export type OpsScopeAgent = {
  id: string;
  status: string;
  enroll_tag: string | null;
};

export type OpsScopeContact = {
  tags: string[];
};

export const OPS_AGENT_STORAGE_KEY = (workspaceId: string) =>
  `upsurge-ops-agent-${workspaceId}`;

export function loadPersistedOpsAgent(workspaceId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(OPS_AGENT_STORAGE_KEY(workspaceId));
  } catch {
    return null;
  }
}

export function savePersistedOpsAgent(workspaceId: string, agentId: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(OPS_AGENT_STORAGE_KEY(workspaceId), agentId);
  } catch {
    /* ignore quota / private mode */
  }
}

/**
 * Prefer the outbound agent with the largest active queue, then the most
 * enrolled contacts. Avoids hiding a populated queue behind the oldest
 * active agent (creation-order default).
 */
export function pickDefaultOpsAgentId(
  outboundAgents: OpsScopeAgent[],
  workspaceEnrollTag: string,
  contacts: OpsScopeContact[],
  queueByAgent: Record<string, number>
): string {
  if (outboundAgents.length === 0) return "";
  const active = outboundAgents.filter((a) => a.status === "active");
  const pool = active.length > 0 ? active : outboundAgents;

  let bestId = pool[0]?.id ?? "";
  let bestQueue = -1;
  let bestEnrolled = -1;
  for (const agent of pool) {
    const tag = effectiveEnrollTag(agent.enroll_tag, workspaceEnrollTag);
    const enrolled = contacts.filter((c) =>
      contactHasEnrollTag(c.tags ?? [], tag)
    ).length;
    const queued = queueByAgent[agent.id] ?? 0;
    if (
      queued > bestQueue ||
      (queued === bestQueue && enrolled > bestEnrolled)
    ) {
      bestId = agent.id;
      bestQueue = queued;
      bestEnrolled = enrolled;
    }
  }
  return bestId;
}
