// =====================================================================
// Retell AI client.
//
// Thin wrapper over the Retell REST API for placing outbound phone calls
// and verifying inbound webhook signatures. `dynamicVariables` is how V2
// memory is injected: whatever we pass here is available in the agent's
// prompt as {{variable}} at call time.
// =====================================================================

const RETELL_BASE = "https://api.retellai.com";

export interface CreatePhoneCallInput {
  fromNumber: string; // E.164
  toNumber: string; // E.164
  agentId: string; // Retell agent id
  /** Injected into the agent prompt as {{key}}. Used for V2 memory + names. */
  dynamicVariables?: Record<string, string>;
  /** Echoed back on the webhook so we can correlate to our call row. */
  metadata?: Record<string, string>;
}

export interface CreatePhoneCallResult {
  callId: string;
}

/** Shape stored in agents.retell_credentials_encrypted (encrypted at rest). */
export interface RetellCredentials {
  apiKey: string;
  webhookSecret?: string;
}

export class RetellClient {
  private apiKey: string;

  constructor(apiKey = process.env.RETELL_API_KEY!) {
    if (!apiKey) throw new Error("RETELL_API_KEY is not set");
    this.apiKey = apiKey;
  }

  async createPhoneCall(input: CreatePhoneCallInput): Promise<CreatePhoneCallResult> {
    const res = await fetch(`${RETELL_BASE}/v2/create-phone-call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_number: input.fromNumber,
        to_number: input.toNumber,
        override_agent_id: input.agentId,
        retell_llm_dynamic_variables: input.dynamicVariables ?? {},
        metadata: input.metadata ?? {},
      }),
    });
    if (!res.ok) {
      throw new Error(`Retell create-phone-call ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { call_id: string };
    return { callId: data.call_id };
  }

  async getCall(callId: string): Promise<any> {
    const res = await fetch(`${RETELL_BASE}/v2/get-call/${callId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Retell get-call ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// ---------------------------------------------------------------------
// Webhook signature verification.
// Retell signs the raw body with HMAC-SHA256 using your webhook secret.
// ---------------------------------------------------------------------
import Retell from "retell-sdk";
import { decryptJson } from "@/lib/crypto";
import type { Agent } from "@/types";

/** Decrypt and return the per-agent webhook secret, if configured. */
export function getRetellWebhookSecretForAgent(
  agent: Pick<Agent, "retell_credentials_encrypted">
): string | null {
  if (!agent.retell_credentials_encrypted) return null;
  try {
    const creds = decryptJson<RetellCredentials>(agent.retell_credentials_encrypted);
    return creds.webhookSecret?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a RetellClient for an agent. Uses the agent's encrypted Retell
 * API key when present; otherwise falls back to RETELL_API_KEY.
 */
export function getRetellClientForAgent(
  agent: Pick<Agent, "retell_credentials_encrypted">
): RetellClient {
  if (agent.retell_credentials_encrypted) {
    try {
      const creds = decryptJson<RetellCredentials>(agent.retell_credentials_encrypted);
      if (creds.apiKey?.trim()) return new RetellClient(creds.apiKey.trim());
    } catch {
      /* fall through to env */
    }
  }
  return new RetellClient();
}

/**
 * Verify a Retell webhook signature against one or more candidate secrets.
 * Evaluates every secret (per-agent first, then env) without short-circuiting
 * so timing does not reveal which secret matched.
 */
export function verifyRetellSignature(
  rawBody: string,
  signature: string | null,
  extraSecrets?: string[]
): boolean {
  if (!signature) return false;

  const candidates: string[] = [];
  if (extraSecrets) {
    for (const s of extraSecrets) {
      if (s?.trim()) candidates.push(s.trim());
    }
  }
  const envSecret = process.env.RETELL_WEBHOOK_SECRET?.trim();
  if (envSecret) candidates.push(envSecret);

  const unique = [...new Set(candidates)];
  if (unique.length === 0) return false;

  let matched = false;
  for (const secret of unique) {
    try {
      matched = Retell.verify(rawBody, secret, signature) || matched;
    } catch {
      /* try next */
    }
  }
  return matched;
}
