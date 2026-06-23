// =====================================================================
// CRM factory. Turns a workspace row into a ready-to-use CrmAdapter by
// decrypting its credentials and instantiating the right implementation.
// =====================================================================
import { decryptJson, encryptJson } from "@/lib/crypto";
import { createServiceClient } from "@/lib/supabase/server";
import type { Agent, Workspace } from "@/types";
import type {
  CrmAdapter,
  FubCredentials,
  HighLevelCredentials,
  HighLevelTokenPersistor,
} from "./types";
import { FollowUpBossAdapter } from "./followupboss";
import { HighLevelAdapter } from "./highlevel";

export * from "./types";

/**
 * Build a persistor that writes a HighLevel adapter's freshly-rotated tokens
 * back into the encrypted `crm_credentials_encrypted` column of the row the
 * adapter was loaded from. Without this, a refreshed token would be lost at
 * the end of the request and every run would burn a refresh.
 */
function persistHighLevelTokens(
  table: "agents" | "workspaces",
  id: string
): HighLevelTokenPersistor {
  return async (creds: HighLevelCredentials) => {
    const supabase = createServiceClient();
    await supabase
      .from(table)
      .update({ crm_credentials_encrypted: encryptJson(creds) })
      .eq("id", id);
  };
}

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
    const persist =
      agent.crm_provider === "highlevel"
        ? persistHighLevelTokens("agents", agent.id)
        : undefined;
    return buildAdapter(agent.crm_provider, creds, persist);
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
      return new HighLevelAdapter(
        creds as HighLevelCredentials,
        persistHighLevelTokens("workspaces", workspace.id)
      );
    default:
      throw new Error(`Unsupported CRM provider: ${workspace.crm_provider}`);
  }
}

/** Build an adapter directly from plaintext creds (used during setup, before save). */
export function buildAdapter(
  provider: Workspace["crm_provider"],
  creds: FubCredentials | HighLevelCredentials,
  onTokensRefreshed?: HighLevelTokenPersistor
): CrmAdapter {
  return provider === "followupboss"
    ? new FollowUpBossAdapter(creds as FubCredentials)
    : new HighLevelAdapter(creds as HighLevelCredentials, onTokensRefreshed);
}
