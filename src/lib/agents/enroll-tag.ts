// Shared enroll-tag helpers for multi-agent workspaces. Each outbound agent
// must use a distinct effective tag so poller segments stay disjoint.

import type { createServiceClient } from "@/lib/supabase/server";

type ServiceDb = ReturnType<typeof createServiceClient>;

export type AgentEnrollTagRow = {
  id?: string;
  direction?: "inbound" | "outbound";
  enroll_tag: string | null;
};

export function normalizeEnrollTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** Agent tag when set; otherwise the workspace default enroll tag. */
export function effectiveEnrollTag(
  agentEnrollTag: string | null | undefined,
  workspaceEnrollTag: string
): string {
  return normalizeEnrollTag(agentEnrollTag ?? workspaceEnrollTag);
}

export function contactHasEnrollTag(
  contactTags: string[] | null | undefined,
  enrollTag: string
): boolean {
  const needle = normalizeEnrollTag(enrollTag);
  return (contactTags ?? []).some((t) => normalizeEnrollTag(t) === needle);
}

/** True when another agent in the workspace already owns this effective tag. */
export function enrollTagConflict(
  candidateTag: string,
  workspaceEnrollTag: string,
  existingAgents: AgentEnrollTagRow[],
  excludeAgentId?: string
): boolean {
  const normalized = normalizeEnrollTag(candidateTag);
  return existingAgents.some((agent) => {
    if (excludeAgentId && agent.id === excludeAgentId) return false;
    if (agent.direction === "inbound") return false;
    return (
      effectiveEnrollTag(agent.enroll_tag, workspaceEnrollTag) === normalized
    );
  });
}

/** Validate outbound agents in a batch (provision wizard). Returns error text or null. */
export function validateAgentEnrollTagsForWorkspace(
  workspaceEnrollTag: string,
  agents: AgentEnrollTagRow[]
): string | null {
  const seen = new Set<string>();
  for (const agent of agents) {
    if (agent.direction === "inbound") continue;
    const tag = effectiveEnrollTag(agent.enroll_tag, workspaceEnrollTag);
    if (seen.has(tag)) {
      return `Duplicate enrollment tag "${tag}" across agents. Each outbound agent needs a distinct tag.`;
    }
    seen.add(tag);
  }
  return null;
}

/** Human-readable error when an enroll tag is already taken. */
export function enrollTagTakenMessage(tag: string): string {
  return `An agent in this workspace already uses the enrollment tag "${tag}". Choose a distinct tag.`;
}

/** Postgres unique-violation on agents.workspace_id + enroll_tag index. */
export function isEnrollTagUniqueViolation(
  error: { code?: string } | null | undefined
): boolean {
  return error?.code === "23505";
}

/**
 * Load workspace agents and verify the candidate enroll tag is not already
 * taken (effective-tag comparison, case-insensitive). Returns error text or
 * null when the tag is available.
 */
export async function assertEnrollTagUnique(
  db: ServiceDb,
  workspaceId: string,
  candidateTag: string,
  workspaceEnrollTag: string,
  excludeAgentId?: string
): Promise<string | null> {
  const { data: existingAgents } = await db
    .from("agents")
    .select("id, direction, enroll_tag")
    .eq("workspace_id", workspaceId)
    .returns<AgentEnrollTagRow[]>();

  const tag = effectiveEnrollTag(candidateTag, workspaceEnrollTag);
  if (
    enrollTagConflict(tag, workspaceEnrollTag, existingAgents ?? [], excludeAgentId)
  ) {
    return enrollTagTakenMessage(tag);
  }
  return null;
}

/** Suggest a unique enroll tag for a duplicated outbound agent. */
export function suggestDuplicateEnrollTag(
  sourceEnrollTag: string | null,
  workspaceEnrollTag: string,
  existingAgents: AgentEnrollTagRow[]
): string {
  const base = `${sourceEnrollTag ?? workspaceEnrollTag}-copy`;
  let candidate = base;
  let n = 2;
  while (enrollTagConflict(candidate, workspaceEnrollTag, existingAgents)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}
