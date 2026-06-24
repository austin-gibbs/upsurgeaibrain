// =====================================================================
// Retell AI client.
//
// Thin wrapper over the Retell REST API for placing outbound phone calls
// and verifying inbound webhook signatures. `dynamicVariables` is how V2
// memory is injected: whatever we pass here is available in the agent's
// prompt as {{variable}} at call time.
// =====================================================================

import { fetchWithTimeout, parseJsonResponse } from "@/lib/http";

const RETELL_BASE = "https://api.retellai.com";
// Placing a call can take a little longer than a metadata read.
const CREATE_CALL_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 15_000;

export interface CreatePhoneCallInput {
  fromNumber: string; // E.164
  toNumber: string; // E.164
  agentId: string; // Retell agent id
  /** Injected into the agent prompt as {{key}}. Used for V2 memory + names. */
  dynamicVariables?: Record<string, string>;
  /** Echoed back on the webhook so we can correlate to our call row. */
  metadata?: Record<string, string>;
  /**
   * Per-call webhook URL. Bound to THIS call so call_started/ended/analyzed
   * are delivered here regardless of agent/account-level config. Required for
   * override_agent_id calls, which otherwise inherit no webhook URL and so
   * never push call_analyzed (outcomes would only land via the reconcile sweep).
   */
  webhookUrl?: string;
}

export interface CreatePhoneCallResult {
  callId: string;
}

export interface ListCallsFilterCriteria {
  agent_id?: string[];
  direction?: Array<"inbound" | "outbound">;
  call_status?: Array<"not_connected" | "ongoing" | "ended" | "error">;
  start_timestamp?: {
    lower_threshold?: number;
    upper_threshold?: number;
  };
}

export interface ListCallsInput {
  filter_criteria?: ListCallsFilterCriteria;
  limit?: number;
  sort_order?: "ascending" | "descending";
  pagination_key?: string;
}

/**
 * Translate our ergonomic filter shape into the v3 list-calls operator format.
 *
 * Retell's v3 endpoint no longer accepts plain arrays/threshold objects for
 * filter fields. Each field is a typed operator object instead:
 *   - enum fields:  `{ type: "enum",  op: "in", value: ["ended"] }`
 *   - number range: `{ type: "range", op: "bt", value: [lower, upper] }`
 *   - number bound: `{ type: "number", op: "ge" | "le", value: n }`
 * and agents move from a top-level `agent_id` array to `agent: [{ agent_id }]`.
 */
function toV3FilterCriteria(
  filter: ListCallsFilterCriteria = {}
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (filter.agent_id && filter.agent_id.length > 0) {
    out.agent = filter.agent_id.map((agent_id) => ({ agent_id }));
  }
  if (filter.call_status && filter.call_status.length > 0) {
    out.call_status = { type: "enum", op: "in", value: filter.call_status };
  }
  if (filter.direction && filter.direction.length > 0) {
    out.direction = { type: "enum", op: "in", value: filter.direction };
  }
  if (filter.start_timestamp) {
    const { lower_threshold, upper_threshold } = filter.start_timestamp;
    if (lower_threshold !== undefined && upper_threshold !== undefined) {
      // RangeFilter: between (inclusive) over [lower, upper].
      out.start_timestamp = {
        type: "range",
        op: "bt",
        value: [lower_threshold, upper_threshold],
      };
    } else if (lower_threshold !== undefined) {
      // NumberFilter: greater-than-or-equal (op "ge", not "gte").
      out.start_timestamp = { type: "number", op: "ge", value: lower_threshold };
    } else if (upper_threshold !== undefined) {
      // NumberFilter: less-than-or-equal (op "le", not "lte").
      out.start_timestamp = { type: "number", op: "le", value: upper_threshold };
    }
  }

  return out;
}

/** Minimal call shape returned by Retell v3 list-calls. */
export interface RetellCallListItem {
  call_id: string;
  agent_id?: string;
  call_type?: string;
  direction?: "inbound" | "outbound";
  call_status?: string;
  start_timestamp?: number;
  end_timestamp?: number;
  duration_ms?: number;
  from_number?: string;
  to_number?: string;
  recording_url?: string;
  disconnection_reason?: string;
  call_analysis?: {
    call_summary?: string;
    call_successful?: boolean;
    user_sentiment?: string;
    in_voicemail?: boolean;
    call_outcome?: string;
    custom_analysis_data?: Record<string, unknown>;
  };
  call_cost?: {
    combined_cost?: number;
    total_duration_seconds?: number;
    product_costs?: Array<{ product: string; cost: number }>;
  };
  latency?: {
    e2e?: { p50?: number; p90?: number; p99?: number };
    llm?: { p50?: number; p90?: number };
    tts?: { p50?: number; p90?: number };
  };
  metadata?: Record<string, string>;
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
    const res = await fetchWithTimeout(`${RETELL_BASE}/v2/create-phone-call`, {
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
        ...(input.webhookUrl ? { webhook_url: input.webhookUrl } : {}),
      }),
      timeoutMs: CREATE_CALL_TIMEOUT_MS,
    });
    if (!res.ok) {
      throw new Error(`Retell create-phone-call ${res.status}: ${await res.text()}`);
    }
    const data = await parseJsonResponse<{ call_id: string }>(res, "Retell create-phone-call");
    return { callId: data.call_id };
  }

  async getCall(callId: string): Promise<any> {
    const res = await fetchWithTimeout(`${RETELL_BASE}/v2/get-call/${callId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`Retell get-call ${res.status}: ${await res.text()}`);
    return parseJsonResponse<any>(res, "Retell get-call");
  }

  /**
   * Fetch one page of calls from Retell v3 list-calls.
   * Returns items plus pagination metadata for follow-up pages.
   */
  async listCallsPage(input: ListCallsInput = {}): Promise<{
    items: RetellCallListItem[];
    pagination_key: string | null;
    has_more: boolean;
  }> {
    const res = await fetchWithTimeout(`${RETELL_BASE}/v3/list-calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter_criteria: toV3FilterCriteria(input.filter_criteria),
        limit: input.limit ?? 1000,
        sort_order: input.sort_order ?? "descending",
        ...(input.pagination_key ? { pagination_key: input.pagination_key } : {}),
      }),
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (!res.ok) {
      throw new Error(`Retell list-calls ${res.status}: ${await res.text()}`);
    }
    const data = await parseJsonResponse<{
      items?: RetellCallListItem[];
      pagination_key?: string | null;
      has_more?: boolean;
    }>(res, "Retell list-calls");
    return {
      items: data.items ?? [],
      pagination_key: data.pagination_key ?? null,
      has_more: data.has_more ?? false,
    };
  }

  /**
   * Paginate through all matching calls up to maxPages (default 10 = 10k calls).
   */
  async listCalls(
    input: ListCallsInput = {},
    maxPages = 10
  ): Promise<RetellCallListItem[]> {
    const all: RetellCallListItem[] = [];
    let paginationKey: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listCallsPage({
        ...input,
        pagination_key: paginationKey,
      });
      all.push(...result.items);
      if (!result.has_more || !result.pagination_key) break;
      paginationKey = result.pagination_key;
    }
    return all;
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
 * All per-agent secrets Retell might have signed a webhook with.
 *
 * Retell signs webhook payloads with your **API key** (`Retell.verify(body,
 * apiKey, signature)`), so the per-agent API key is itself a valid signing
 * secret — not just the optional `webhookSecret`. Returning both lets a single
 * agent be verified regardless of which value Retell used.
 */
export function getRetellSignatureCandidatesForAgent(
  agent: Pick<Agent, "retell_credentials_encrypted">
): string[] {
  if (!agent.retell_credentials_encrypted) return [];
  try {
    const creds = decryptJson<RetellCredentials>(agent.retell_credentials_encrypted);
    const out: string[] = [];
    if (creds.apiKey?.trim()) out.push(creds.apiKey.trim());
    if (creds.webhookSecret?.trim()) out.push(creds.webhookSecret.trim());
    return out;
  } catch {
    return [];
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

/** Collect all candidate webhook signing secrets (per-agent + env). */
export function listWebhookSecretCandidates(extraSecrets?: string[]): string[] {
  const candidates: string[] = [];
  if (extraSecrets) {
    for (const s of extraSecrets) {
      if (s?.trim()) candidates.push(s.trim());
    }
  }
  const envSecret = process.env.RETELL_WEBHOOK_SECRET?.trim();
  if (envSecret) candidates.push(envSecret);
  // Retell signs webhooks with your API key (Retell.verify(body, apiKey, sig)),
  // so the account API key is itself a valid signing secret. Including it here
  // means verification succeeds even when no dedicated webhook secret is set.
  const envApiKey = process.env.RETELL_API_KEY?.trim();
  if (envApiKey) candidates.push(envApiKey);
  return [...new Set(candidates)];
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

  const unique = listWebhookSecretCandidates(extraSecrets);
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
