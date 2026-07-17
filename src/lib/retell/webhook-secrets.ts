// =====================================================================
// Resolve per-agent Retell webhook signing secrets from a webhook payload.
//
// Retell signs with the account API key used to place the call. Workspaces
// with their own Retell account (e.g. Nil Patel / FUB) MUST have their per-
// agent key in the candidate list — env RETELL_API_KEY alone is not enough.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import { getRetellSignatureCandidatesForAgent } from "./client";

type WebhookCallPayload = {
  call_id?: string;
  agent_id?: string;
  metadata?: {
    agent_id?: string;
    call_id?: string;
  };
};

export type WebhookPayloadShape = {
  call?: WebhookCallPayload;
};

function appendSecrets(
  target: string[],
  row: { retell_credentials_encrypted: string | null } | null
): void {
  if (!row) return;
  for (const secret of getRetellSignatureCandidatesForAgent(row)) {
    target.push(secret);
  }
}

/** Collect signing secrets from every resolvable agent row (deduped). */
export async function resolvePerAgentWebhookSecrets(
  body: WebhookPayloadShape
): Promise<string[]> {
  const supabase = createServiceClient();
  const secrets: string[] = [];
  const seenAgentIds = new Set<string>();

  async function loadByOurAgentId(agentId: string | undefined): Promise<void> {
    if (!agentId || seenAgentIds.has(agentId)) return;
    seenAgentIds.add(agentId);
    const { data } = await supabase
      .from("agents")
      .select("retell_credentials_encrypted")
      .eq("id", agentId)
      .maybeSingle<{ retell_credentials_encrypted: string | null }>();
    appendSecrets(secrets, data);
  }

  async function loadByRetellAgentId(retellAgentId: string | undefined): Promise<void> {
    if (!retellAgentId) return;
    // Multiple UpSurge agents can share one Retell agent_id (e.g. Diamond
    // Seller + Buyer/Seller). maybeSingle() 400s on that and drops secrets.
    const { data } = await supabase
      .from("agents")
      .select("id, retell_credentials_encrypted")
      .eq("retell_agent_id", retellAgentId)
      .returns<{ id: string; retell_credentials_encrypted: string | null }[]>();
    for (const row of data ?? []) {
      if (seenAgentIds.has(row.id)) continue;
      seenAgentIds.add(row.id);
      appendSecrets(secrets, row);
    }
  }

  async function loadByOurCallId(callId: string | undefined): Promise<void> {
    if (!callId) return;
    const { data } = await supabase
      .from("calls")
      .select("agent_id")
      .eq("id", callId)
      .maybeSingle<{ agent_id: string }>();
    await loadByOurAgentId(data?.agent_id);
  }

  async function loadByRetellCallId(retellCallId: string | undefined): Promise<void> {
    if (!retellCallId) return;
    const { data } = await supabase
      .from("calls")
      .select("agent_id")
      .eq("retell_call_id", retellCallId)
      .maybeSingle<{ agent_id: string }>();
    await loadByOurAgentId(data?.agent_id);
  }

  const call = body.call ?? {};

  // Run every resolver — do not short-circuit. Separate Retell accounts (FUB)
  // often need metadata/call-row fallbacks even when retell_agent_id lookup
  // returns an agent row with empty decrypt.
  await Promise.all([
    loadByRetellAgentId(call.agent_id),
    loadByOurAgentId(call.metadata?.agent_id),
    loadByOurCallId(call.metadata?.call_id),
    loadByRetellCallId(call.call_id),
  ]);

  return [...new Set(secrets)];
}

/** Parse raw webhook body and resolve per-agent signing secrets. */
export async function perAgentWebhookSecretsFromBody(rawBody: string): Promise<string[]> {
  try {
    const body = JSON.parse(rawBody) as WebhookPayloadShape;
    return resolvePerAgentWebhookSecrets(body);
  } catch {
    return [];
  }
}

/**
 * All stored per-agent Retell API keys / webhook secrets.
 *
 * Used as a second-pass signature candidate list when the targeted agent
 * lookup misses (shared Retell agent ids, stale metadata) or when Retell
 * signs with a different key on the same account than the one we resolved
 * first. Bounded by the small number of agents in the platform.
 */
export async function listAllAgentRetellSecrets(): Promise<string[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("agents")
    .select("retell_credentials_encrypted")
    .not("retell_credentials_encrypted", "is", null)
    .returns<{ retell_credentials_encrypted: string | null }[]>();

  const secrets: string[] = [];
  for (const row of data ?? []) {
    appendSecrets(secrets, row);
  }
  return [...new Set(secrets)];
}

/**
 * Fallback auth when HMAC verification fails: prove the call exists in the
 * Retell account that owns the resolved agent. Retell only signs with the
 * account's designated "webhook" API key, which can differ from the dialing
 * key stored on the agent — this path still authenticates those deliveries.
 */
export async function authenticateWebhookViaRetellApi(
  rawBody: string
): Promise<boolean> {
  let body: WebhookPayloadShape;
  try {
    body = JSON.parse(rawBody) as WebhookPayloadShape;
  } catch {
    return false;
  }

  const retellCallId = body.call?.call_id?.trim();
  if (!retellCallId) return false;

  const secrets = await resolvePerAgentWebhookSecrets(body);
  const keys = secrets.length > 0 ? secrets : await listAllAgentRetellSecrets();
  if (keys.length === 0) return false;

  for (const apiKey of keys) {
    try {
      const res = await fetch(
        `https://api.retellai.com/v2/get-call/${encodeURIComponent(retellCallId)}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          // Keep the webhook handler snappy — reconcile will catch misses.
          signal: AbortSignal.timeout(4_000),
        }
      );
      if (res.ok) return true;
    } catch {
      /* try next key */
    }
  }
  return false;
}
