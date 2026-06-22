// =====================================================================
// CRM factory. Turns a workspace row into a ready-to-use CrmAdapter by
// decrypting its credentials and instantiating the right implementation.
// =====================================================================
import { decryptJson } from "@/lib/crypto";
import type { Agent, Workspace } from "@/types";
import type { CrmAdapter, FubCredentials, HighLevelCredentials } from "./types";
import { FollowUpBossAdapter } from "./followupboss";
import { HighLevelAdapter } from "./highlevel";

export * from "./types";

/**
 * Resolve the CRM adapter for an agent. Agents may carry their own CRM
 * provider + credentials (set in the create-agent flow); when they don't,
 * the agent inherits the workspace-level CRM. This keeps pre-0006 agents
 * (no per-agent CRM) working unchanged.
 */
export function getCrmAdapterForAgent(agent: Agent, workspace: Workspace): CrmAdapter {
  if (agent.crm_provider && agent.crm_credentials_encrypted) {
    const creds = decryptJson<FubCredentials | HighLevelCredentials>(
      agent.crm_credentials_encrypted
    );
    return buildAdapter(agent.crm_provider, creds);
  }
  return getCrmAdapter(workspace);
}

export function getCrmAdapter(workspace: Workspace): CrmAdapter {
  if (!workspace.crm_credentials_encrypted) {
    throw new Error(`Workspace ${workspace.id} has no CRM credentials configured`);
  }
  const creds = decryptJson<FubCredentials | HighLevelCredentials>(
    workspace.crm_credentials_encrypted
  );

  switch (workspace.crm_provider) {
    case "followupboss":
      return new FollowUpBossAdapter(creds as FubCredentials);
    case "highlevel":
      return new HighLevelAdapter(creds as HighLevelCredentials);
    default:
      throw new Error(`Unsupported CRM provider: ${workspace.crm_provider}`);
  }
}

/** Build an adapter directly from plaintext creds (used during setup, before save). */
export function buildAdapter(
  provider: Workspace["crm_provider"],
  creds: FubCredentials | HighLevelCredentials
): CrmAdapter {
  return provider === "followupboss"
    ? new FollowUpBossAdapter(creds as FubCredentials)
    : new HighLevelAdapter(creds as HighLevelCredentials);
}
