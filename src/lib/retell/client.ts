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

/**
 * Which key authenticated a request: the agent's own stored key, or the
 * platform-wide RETELL_API_KEY fallback. Auth failures are only actionable if
 * the operator knows which of the two Retell rejected.
 */
export type RetellKeySource = "agent" | "platform";

/** Turn Retell create-phone-call failures into actionable operator messages. */
export function formatCreatePhoneCallError(
  status: number,
  body: string,
  keySource: RetellKeySource = "platform"
): string {
  const original = `Retell create-phone-call ${status}: ${body}`;
  if (status === 401 || status === 403) {
    return keySource === "agent"
      ? `Retell rejected the API key saved on this agent. Open the agent's settings page and re-save the API key for the Retell account that owns its from-number. Note each agent carries its own key, so fixing one agent does not fix the others. Original: ${original}`
      : `Retell rejected the platform RETELL_API_KEY, and this agent has no key of its own. Save this agent's Retell API key on its settings page. Original: ${original}`;
  }
  if (status === 404 && body.includes("not found from phone-number")) {
    const match = body.match(/Item (\+\d+)/);
    const fromNumber = match?.[1];
    return fromNumber
      ? `Outbound caller ID ${fromNumber} was not found in the Retell account used for this agent. Add the correct Retell API key on the agent settings page (required when the agent uses a dedicated Retell account). Original: ${original}`
      : original;
  }
  return original;
}

/**
 * Ask Retell whether an API key is usable, so a bad key is caught while the
 * operator is still looking at the field they typed it into rather than at a
 * failed call days later.
 *
 * Returns an operator-facing message only when Retell *definitively* rejects
 * the key. A check we could not complete (timeout, Retell outage) returns null:
 * our own connectivity must never block saving credentials.
 */
export async function verifyRetellApiKey(apiKey: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${RETELL_BASE}/list-phone-numbers`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: READ_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    return "Retell rejected this API key. Copy it from Retell Dashboard > API Keys for the account that owns this agent's phone numbers, then save again.";
  }
  return null;
}
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
  /** Offset for v3 list-calls pagination. Do not combine with pagination_key. */
  skip?: number;
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
        value: [
          Math.floor(lower_threshold),
          Math.floor(upper_threshold),
        ],
      };
    } else if (lower_threshold !== undefined) {
      // NumberFilter: greater-than-or-equal (op "ge", not "gte").
      out.start_timestamp = {
        type: "number",
        op: "ge",
        value: Math.floor(lower_threshold),
      };
    } else if (upper_threshold !== undefined) {
      // NumberFilter: less-than-or-equal (op "le", not "lte").
      out.start_timestamp = {
        type: "number",
        op: "le",
        value: Math.floor(upper_threshold),
      };
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
  private keySource: RetellKeySource;

  constructor(
    apiKey = process.env.RETELL_API_KEY!,
    keySource: RetellKeySource = "platform"
  ) {
    if (!apiKey) throw new Error("RETELL_API_KEY is not set");
    this.apiKey = apiKey;
    this.keySource = keySource;
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
      const body = await res.text();
      throw new Error(formatCreatePhoneCallError(res.status, body, this.keySource));
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
   * Bind agent-level webhook delivery (defense when per-call webhook_url is ignored).
   * Idempotent — safe to call before dials for agents on separate Retell accounts.
   *
   * Retell `update-agent` writes a draft version. Phone numbers pinned to a
   * published version (or `latest_published`) keep delivering to the OLD
   * webhook until that draft is published — so we publish immediately after
   * the PATCH when the draft is unpublished.
   */
  async ensureAgentWebhookUrl(agentId: string, webhookUrl: string): Promise<void> {
    const res = await fetchWithTimeout(`${RETELL_BASE}/update-agent/${agentId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook_url: webhookUrl,
        webhook_events: ["call_started", "call_ended", "call_analyzed"],
      }),
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (!res.ok) {
      throw new Error(`Retell update-agent ${res.status}: ${await res.text()}`);
    }

    const updated = (await parseJsonResponse<{
      version?: number;
      is_published?: boolean;
      webhook_url?: string | null;
    }>(res, "Retell update-agent")) as {
      version?: number;
      is_published?: boolean;
      webhook_url?: string | null;
    };

    if (updated.is_published) return;
    if (typeof updated.version !== "number") {
      // Response shape unexpected — re-fetch so we still publish when needed.
      const getRes = await fetchWithTimeout(`${RETELL_BASE}/get-agent/${agentId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeoutMs: READ_TIMEOUT_MS,
      });
      if (!getRes.ok) {
        throw new Error(
          `Retell get-agent after webhook bind ${getRes.status}: ${await getRes.text()}`
        );
      }
      const agent = await parseJsonResponse<{
        version?: number;
        is_published?: boolean;
      }>(getRes, "Retell get-agent");
      if (agent.is_published || typeof agent.version !== "number") return;
      await this.publishAgentVersion(agentId, agent.version);
      return;
    }
    await this.publishAgentVersion(agentId, updated.version);
  }

  /** Publish a draft agent version so phone traffic picks up the new config. */
  async publishAgentVersion(agentId: string, version: number): Promise<void> {
    const res = await fetchWithTimeout(
      `${RETELL_BASE}/publish-agent-version/${agentId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          version,
          version_title: "UpSurge webhook bind",
          version_description:
            "Publish agent-level webhook_url so inbound phone calls deliver call_analyzed to UpSurge",
        }),
        timeoutMs: READ_TIMEOUT_MS,
      }
    );
    if (!res.ok) {
      throw new Error(
        `Retell publish-agent-version ${res.status}: ${await res.text()}`
      );
    }
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
        // v3 rejects bodies that include both skip and pagination_key; use skip only.
        ...(input.skip ? { skip: input.skip } : {}),
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
    const limit = input.limit ?? 1000;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listCallsPage({
        ...input,
        skip: page * limit,
      });
      all.push(...result.items);
      if (!result.has_more || result.items.length < limit) break;
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
      if (creds.apiKey?.trim()) return new RetellClient(creds.apiKey.trim(), "agent");
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
