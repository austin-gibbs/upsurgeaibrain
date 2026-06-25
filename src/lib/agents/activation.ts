import {
  effectiveEnrollTag,
  enrollTagConflict,
  type AgentEnrollTagRow,
} from "./enroll-tag";
import { hasEffectiveCrmCredentials, type CrmCarrier } from "./crm-inheritance";

export type ActivationContext = {
  agentId: string;
  direction: "inbound" | "outbound";
  enrollTag: string | null;
  retellAgentId: string | null;
  retellFromNumber: string | null;
  retellCredentialsEncrypted: string | null;
  workspaceEnrollTag: string;
  existingAgents: AgentEnrollTagRow[];
  agent: CrmCarrier;
  workspace: CrmCarrier;
  hasCallConfig: boolean;
};

/** Returns an error message when activation should be blocked, else null. */
export function validateAgentActivation(ctx: ActivationContext): string | null {
  if (ctx.direction === "inbound") {
    if (!ctx.retellAgentId?.trim()) {
      return "Cannot activate: inbound agents need a Retell agent ID first.";
    }
    if (!ctx.retellCredentialsEncrypted) {
      return "Cannot activate: inbound agents need Retell credentials first.";
    }
    if (!hasEffectiveCrmCredentials(ctx.agent, ctx.workspace)) {
      return "Cannot activate: connect CRM credentials on the workspace or this agent first.";
    }
    return null;
  }

  // Outbound
  if (!ctx.retellAgentId?.trim()) {
    return "Cannot activate: agent needs a Retell agent ID first.";
  }
  if (!ctx.retellFromNumber?.trim()) {
    return "Cannot activate: outbound agents need a Retell from-number first.";
  }
  if (!hasEffectiveCrmCredentials(ctx.agent, ctx.workspace)) {
    return "Cannot activate: connect CRM credentials on the workspace or this agent first.";
  }
  if (!ctx.hasCallConfig) {
    return "Cannot activate: save call settings (call window, cadence) first.";
  }

  const tag = ctx.enrollTag?.trim();
  if (!tag) {
    const outboundPeers = ctx.existingAgents.filter(
      (a) => a.id !== ctx.agentId && a.direction !== "inbound"
    );
    if (outboundPeers.length > 0) {
      return "Cannot activate: outbound agents in multi-agent workspaces need their own enrollment tag.";
    }
  } else if (
    enrollTagConflict(tag, ctx.workspaceEnrollTag, ctx.existingAgents, ctx.agentId)
  ) {
    return `Cannot activate: enrollment tag "${effectiveEnrollTag(tag, ctx.workspaceEnrollTag)}" is already used by another agent in this workspace.`;
  }

  return null;
}
