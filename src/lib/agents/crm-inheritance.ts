// CRM credential inheritance: workspace CRM is the default token store for every
// agent in that workspace. Multiple agents on the same HighLevel location MUST
// share one token store — duplicate OAuth copies rotate each other out and
// de-auth sibling agents.

import type { CrmProvider } from "@/types";

export type CrmCarrier = {
  crm_provider: CrmProvider | null;
  crm_credentials_encrypted: string | null;
};

export function agentHasOwnCrmCredentials(agent: CrmCarrier): boolean {
  return Boolean(agent.crm_provider && agent.crm_credentials_encrypted);
}

export function workspaceHasCrmCredentials(workspace: CrmCarrier): boolean {
  return Boolean(workspace.crm_provider && workspace.crm_credentials_encrypted);
}

/**
 * Agents use workspace CRM whenever the workspace has credentials. The optional
 * workspace argument keeps older unit tests/callers working while making the
 * product behavior explicit for runtime/UI callers.
 */
export function agentInheritsWorkspaceCrm(
  agent: CrmCarrier,
  workspace?: CrmCarrier
): boolean {
  if (workspace && workspaceHasCrmCredentials(workspace)) return true;
  return !agentHasOwnCrmCredentials(agent);
}

export function hasEffectiveCrmCredentials(
  agent: CrmCarrier,
  workspace: CrmCarrier
): boolean {
  return (
    workspaceHasCrmCredentials(workspace) || agentHasOwnCrmCredentials(agent)
  );
}

export function effectiveCrmProvider(
  agent: CrmCarrier,
  workspace: CrmCarrier
): CrmProvider | null {
  if (workspace.crm_provider && workspace.crm_credentials_encrypted) {
    return workspace.crm_provider;
  }
  if (agent.crm_provider && agent.crm_credentials_encrypted) {
    return agent.crm_provider;
  }
  return agent.crm_provider ?? workspace.crm_provider ?? null;
}

export type CrmInheritanceAudit = {
  agentId: string;
  agentName: string;
  inheritsWorkspaceCrm: boolean;
  hasOwnCrmCredentials: boolean;
  workspaceHasCrmCredentials: boolean;
  effectiveProvider: CrmProvider | null;
  recommendation: string | null;
};

/**
 * Audit a single agent's CRM wiring for multi-agent HighLevel workspaces.
 * When workspace and agent both store credentials, workspace wins and we
 * recommend clearing the agent copy so refresh tokens stay in one place.
 */
export function auditCrmInheritance(
  agent: CrmCarrier & { id: string; name: string },
  workspace: CrmCarrier
): CrmInheritanceAudit {
  const inherits = agentInheritsWorkspaceCrm(agent, workspace);
  const own = agentHasOwnCrmCredentials(agent);
  const ws = workspaceHasCrmCredentials(workspace);
  const provider = effectiveCrmProvider(agent, workspace);

  let recommendation: string | null = null;
  if (own && ws && provider === "highlevel") {
    recommendation =
      "Clear this agent's duplicate HighLevel credentials. The workspace connection is active and will be used for this agent.";
  } else if (!own && !ws) {
    recommendation =
      "Neither this agent nor its workspace has CRM credentials. Connect CRM at the workspace level or on this agent before activating.";
  } else if (inherits && ws) {
    recommendation = null;
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    inheritsWorkspaceCrm: inherits,
    hasOwnCrmCredentials: own,
    workspaceHasCrmCredentials: ws,
    effectiveProvider: provider,
    recommendation,
  };
}
