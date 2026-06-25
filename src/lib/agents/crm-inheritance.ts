// CRM credential inheritance: agents may store their own encrypted CRM creds,
// or inherit the workspace connection. Multiple agents on the same HighLevel
// location MUST share one token store — duplicate OAuth copies rotate each
// other out and de-auth sibling agents.

export type CrmCarrier = {
  crm_provider: "followupboss" | "highlevel" | null;
  crm_credentials_encrypted: string | null;
};

export function agentHasOwnCrmCredentials(agent: CrmCarrier): boolean {
  return Boolean(agent.crm_provider && agent.crm_credentials_encrypted);
}

export function workspaceHasCrmCredentials(workspace: CrmCarrier): boolean {
  return Boolean(workspace.crm_provider && workspace.crm_credentials_encrypted);
}

/** Agent inherits workspace CRM when it stores no credentials of its own. */
export function agentInheritsWorkspaceCrm(agent: CrmCarrier): boolean {
  return !agentHasOwnCrmCredentials(agent);
}

export function hasEffectiveCrmCredentials(
  agent: CrmCarrier,
  workspace: CrmCarrier
): boolean {
  return (
    agentHasOwnCrmCredentials(agent) || workspaceHasCrmCredentials(workspace)
  );
}

export function effectiveCrmProvider(
  agent: CrmCarrier,
  workspace: CrmCarrier
): "followupboss" | "highlevel" | null {
  if (agent.crm_provider && agent.crm_credentials_encrypted) {
    return agent.crm_provider;
  }
  if (workspace.crm_provider && workspace.crm_credentials_encrypted) {
    return workspace.crm_provider;
  }
  return agent.crm_provider ?? workspace.crm_provider ?? null;
}

export type CrmInheritanceAudit = {
  agentId: string;
  agentName: string;
  inheritsWorkspaceCrm: boolean;
  hasOwnCrmCredentials: boolean;
  workspaceHasCrmCredentials: boolean;
  effectiveProvider: "followupboss" | "highlevel" | null;
  recommendation: string | null;
};

/**
 * Audit a single agent's CRM wiring for multi-agent HighLevel workspaces.
 * When workspace and agent both store credentials for the same location,
 * recommend clearing the agent copy so refresh tokens stay in one place.
 */
export function auditCrmInheritance(
  agent: CrmCarrier & { id: string; name: string },
  workspace: CrmCarrier
): CrmInheritanceAudit {
  const inherits = agentInheritsWorkspaceCrm(agent);
  const own = agentHasOwnCrmCredentials(agent);
  const ws = workspaceHasCrmCredentials(workspace);
  const provider = effectiveCrmProvider(agent, workspace);

  let recommendation: string | null = null;
  if (own && ws && provider === "highlevel") {
    recommendation =
      "Clear this agent's HighLevel credentials and inherit the workspace connection so OAuth refresh tokens are not duplicated for the same location.";
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
