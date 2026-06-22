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

export function verifyRetellSignature(rawBody: string, signature: string | null): boolean {
  // Retell signs webhooks with the account's webhook signing secret using the
  // SDK scheme ("v=<ts>,d=<hmac(body+ts, secret)>", 5-min tolerance). This
  // secret is distinct from the API key used for REST calls.
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  try {
    return Retell.verify(rawBody, secret, signature);
  } catch {
    return false;
  }
}
