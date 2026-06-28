// =====================================================================
// Retell AI authoring.
//
// The call-path client (`./client.ts`) only PLACES calls and verifies
// webhooks — it deliberately does not author agents. This module adds the
// REST calls needed to CREATE a Retell agent end-to-end so a new voice
// agent can be stood up programmatically (Claude/Cowork provisioning flow):
//
//   1. create a Retell LLM (the conversation brain + first message), OR
//      reuse an existing Conversation Flow by id;
//   2. create the agent, wiring the response engine, voice, webhook, and —
//      critically — the post-call analysis `call_outcome` field whose enum
//      choices must match the classifier's ALIAS map (see lib/engine/outcome.ts),
//      otherwise every outcome falls back to no_answer_voicemail;
//   3. provision (buy) a phone number bound to the agent.
//
// Every outbound call goes through fetchWithTimeout so a hung Retell socket
// aborts instead of wedging the caller.
// =====================================================================
import { fetchWithTimeout, parseJsonResponse } from "@/lib/http";
import type { CallOutcome } from "@/types";

const RETELL_BASE = "https://api.retellai.com";
const AUTHOR_TIMEOUT_MS = 30_000;

/**
 * The outcome strings the agent's post-call analysis is allowed to emit.
 *
 * These are exactly the canonical values that `classifyOutcome` accepts as
 * direct keys in its ALIAS map. Emitting anything outside this set makes the
 * classifier fall back to no_answer_voicemail and the contact keeps getting
 * dialed — so the Retell enum MUST stay in lockstep with the ALIAS map.
 * `error` is internal-only (never produced by the model).
 */
export const RETELL_OUTCOME_CHOICES: Exclude<CallOutcome, "error">[] = [
  "no_answer_voicemail",
  "appointment",
  "not_interested",
  "dnd",
  "interested_no_appointment",
  "follow_up",
];

/** Post-call analysis field that drives outcome classification. */
export const CALL_OUTCOME_ANALYSIS_FIELD = {
  type: "enum" as const,
  name: "call_outcome",
  description:
    "The single best-fit outcome of this call. " +
    "appointment = a meeting/appointment was scheduled. " +
    "not_interested = the contact declined or is not interested. " +
    "dnd = the contact asked to be removed / do not call. " +
    "interested_no_appointment = interested but did not book. " +
    "follow_up = wants a callback later / not reached but should be retried. " +
    "no_answer_voicemail = no answer, voicemail, or could not connect. " +
    "Choose exactly one.",
  choices: [...RETELL_OUTCOME_CHOICES],
};

/**
 * Default post-call analysis fields. `call_outcome` is required for the
 * engine; the rest are convenience fields surfaced in CRM notes/summaries.
 */
export const DEFAULT_POST_CALL_ANALYSIS_DATA: Array<Record<string, unknown>> = [
  CALL_OUTCOME_ANALYSIS_FIELD,
  {
    type: "string",
    name: "appointment_time",
    description:
      "If an appointment was set, the date/time agreed (free text). Empty otherwise.",
  },
];

async function retellAuthorRequest<T>(
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  label: string
): Promise<T> {
  const res = await fetchWithTimeout(`${RETELL_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    timeoutMs: AUTHOR_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`${label} ${res.status}: ${await res.text()}`);
  }
  return parseJsonResponse<T>(res, label);
}

export interface CreateRetellLlmInput {
  /** Conversation prompt (the agent's brain). */
  generalPrompt: string;
  /** First thing the agent says when the call connects. */
  beginMessage?: string;
  /** Underlying model. Defaults to a current Retell-supported model. */
  model?: string;
}

/** Create a Retell LLM. Returns its llm_id for wiring into an agent. */
export async function createRetellLlm(
  apiKey: string,
  input: CreateRetellLlmInput
): Promise<{ llmId: string }> {
  const data = await retellAuthorRequest<{ llm_id: string }>(
    apiKey,
    "/create-retell-llm",
    {
      model: input.model ?? "gpt-4o",
      general_prompt: input.generalPrompt,
      ...(input.beginMessage ? { begin_message: input.beginMessage } : {}),
      // A graceful hangup tool so the agent can end calls cleanly.
      general_tools: [{ type: "end_call", name: "end_call" }],
    },
    "Retell create-retell-llm"
  );
  return { llmId: data.llm_id };
}

/** The conversation engine an agent runs on. */
export type RetellResponseEngine =
  | { type: "retell-llm"; llmId: string }
  | { type: "conversation-flow"; conversationFlowId: string };

export interface CreateRetellAgentInput {
  agentName: string;
  responseEngine: RetellResponseEngine;
  /** Retell voice id, e.g. "11labs-Adrian". */
  voiceId?: string;
  language?: string;
  /** Where call_started/ended/analyzed are delivered. */
  webhookUrl?: string;
  /** Post-call analysis fields. Defaults to DEFAULT_POST_CALL_ANALYSIS_DATA. */
  postCallAnalysisData?: Array<Record<string, unknown>>;
}

/** Create a Retell agent. Returns its agent_id. */
export async function createRetellAgent(
  apiKey: string,
  input: CreateRetellAgentInput
): Promise<{ agentId: string }> {
  const response_engine =
    input.responseEngine.type === "retell-llm"
      ? { type: "retell-llm", llm_id: input.responseEngine.llmId }
      : {
          type: "conversation-flow",
          conversation_flow_id: input.responseEngine.conversationFlowId,
        };

  const data = await retellAuthorRequest<{ agent_id: string }>(
    apiKey,
    "/create-agent",
    {
      agent_name: input.agentName,
      response_engine,
      voice_id: input.voiceId ?? "11labs-Adrian",
      language: input.language ?? "en-US",
      post_call_analysis_data:
        input.postCallAnalysisData ?? DEFAULT_POST_CALL_ANALYSIS_DATA,
      ...(input.webhookUrl
        ? {
            webhook_url: input.webhookUrl,
          }
        : {}),
    },
    "Retell create-agent"
  );
  return { agentId: data.agent_id };
}

export interface CreateRetellPhoneNumberInput {
  /** Preferred US area code (e.g. 470). Retell picks within it when available. */
  areaCode?: number;
  /** Bind the new number's outbound caller flow to this agent. */
  outboundAgentId?: string;
  /** Bind inbound answering to this agent. */
  inboundAgentId?: string;
  nickname?: string;
}

/** Buy a Retell-managed phone number. Returns the E.164 number. */
export async function createRetellPhoneNumber(
  apiKey: string,
  input: CreateRetellPhoneNumberInput
): Promise<{ phoneNumber: string }> {
  // Retell deprecated the single-agent fields (outbound_agent_id /
  // inbound_agent_id) on 2026-03-31 in favor of weighted agent lists. Bind a
  // single agent as a one-entry list with weight 1.
  // https://docs.retellai.com/deprecation-notice/2026/03-31_phone_number_agent_fields
  const data = await retellAuthorRequest<{ phone_number: string }>(
    apiKey,
    "/create-phone-number",
    {
      ...(input.areaCode ? { area_code: input.areaCode } : {}),
      ...(input.outboundAgentId
        ? { outbound_agents: [{ agent_id: input.outboundAgentId, weight: 1 }] }
        : {}),
      ...(input.inboundAgentId
        ? { inbound_agents: [{ agent_id: input.inboundAgentId, weight: 1 }] }
        : {}),
      ...(input.nickname ? { nickname: input.nickname } : {}),
    },
    "Retell create-phone-number"
  );
  return { phoneNumber: data.phone_number };
}

/** Read an agent back (used to confirm creation / fetch metadata). */
export async function getRetellAgent(
  apiKey: string,
  agentId: string
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${RETELL_BASE}/get-agent/${agentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: AUTHOR_TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`Retell get-agent ${res.status}: ${await res.text()}`);
  }
  return parseJsonResponse<Record<string, unknown>>(res, "Retell get-agent");
}
