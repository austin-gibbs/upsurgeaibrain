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
    const { data } = await supabase
      .from("agents")
      .select("id, retell_credentials_encrypted")
      .eq("retell_agent_id", retellAgentId)
      .maybeSingle<{ id: string; retell_credentials_encrypted: string | null }>();
    if (data?.id) seenAgentIds.add(data.id);
    appendSecrets(secrets, data);
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
