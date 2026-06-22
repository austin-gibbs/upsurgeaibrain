// =====================================================================
// CRM factory. Turns a workspace row into a ready-to-use CrmAdapter by
// decrypting its credentials and instantiating the right implementation.
// =====================================================================
import { decryptJson } from "@/lib/crypto";
import type { Workspace } from "@/types";
import type { CrmAdapter, FubCredentials, HighLevelCredentials } from "./types";
import { FollowUpBossAdapter } from "./followupboss";
import { HighLevelAdapter } from "./highlevel";

export * from "./types";

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
