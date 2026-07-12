// Enroll-tag resolution and local contact enrollment checks.
import type { Agent, Contact, Workspace } from "@/types";

/** Effective enroll tag for an agent (agent override, else workspace default). */
export function resolveEnrollTag(
  agent: Pick<Agent, "enroll_tag">,
  workspace: Pick<Workspace, "enroll_tag">
): string | null {
  const tag = agent.enroll_tag ?? workspace.enroll_tag;
  return tag?.trim() ? tag : null;
}

/** True when the cached contact still carries the agent's enroll tag. */
export function contactHasEnrollTag(
  contact: Pick<Contact, "tags">,
  enrollTag: string
): boolean {
  return contact.tags.includes(enrollTag);
}

/** True when a live dial should proceed for this contact. */
export function isContactEnrolledForAgent(
  contact: Pick<Contact, "tags">,
  agent: Pick<Agent, "enroll_tag">,
  workspace: Pick<Workspace, "enroll_tag">
): boolean {
  const enrollTag = resolveEnrollTag(agent, workspace);
  if (!enrollTag) return true;
  return contactHasEnrollTag(contact, enrollTag);
}
