// =====================================================================
// Inbound API-key auth for the custom-integration "trigger call" endpoint.
//
// External apps (e.g. SellMyFISBO) authenticate with
//   Authorization: Bearer <token>
// We persist ONLY the SHA-256 hash of the token (integration_api_keys), never
// the token itself. Each key maps to the workspace + outbound agent that should
// place the call. Service-role only; end users never query this table.
// =====================================================================
import crypto from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";

export interface ResolvedApiKey {
  id: string;
  workspaceId: string;
  agentId: string | null;
}

/** SHA-256 hex of a raw bearer token — matches integration_api_keys.token_hash. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Pull the bearer token out of an Authorization header (case-insensitive scheme). */
export function bearerFromHeader(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/**
 * Resolve a raw bearer token to its workspace + agent. Returns null when the
 * token is unknown or deactivated. Best-effort stamps last_used_at.
 */
export async function resolveApiKey(token: string): Promise<ResolvedApiKey | null> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("integration_api_keys")
    .select("id, workspace_id, agent_id, active")
    .eq("token_hash", hashToken(token))
    .maybeSingle<{
      id: string;
      workspace_id: string;
      agent_id: string | null;
      active: boolean;
    }>();
  if (!data || !data.active) return null;

  // Best-effort usage stamp; never block the call on this.
  void supabase
    .from("integration_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => undefined, () => undefined);

  return { id: data.id, workspaceId: data.workspace_id, agentId: data.agent_id };
}
