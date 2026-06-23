// =====================================================================
// Agent memory (V2).
//
// The differentiator: each agent keeps a rolling, per-contact memory that
// is injected into Retell at call time and updated after every call. The
// agent therefore continues the relationship instead of starting cold.
//
// Two halves:
//   buildDynamicVariables()  — READ path, runs before a call (caller.ts).
//   updateMemoryAfterCall()  — WRITE path, runs after analysis (process-outcome).
//
// The LLM summarizer is stubbed with a deterministic fallback so the
// scaffold runs without an LLM key; wire ANTHROPIC_API_KEY to enable.
// =====================================================================
import type { Agent, AgentMemory, Contact } from "@/types";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * READ: turn stored memory + contact + agent objective into the dynamic
 * variables Retell will expose as {{...}} in the prompt.
 */
export function buildDynamicVariables(params: {
  agent: Agent;
  contact: Contact;
  memory: AgentMemory | null;
  attemptNumber: number;
}): Record<string, string> {
  const { agent, contact, memory, attemptNumber } = params;
  return {
    contact_name: contact.full_name ?? "there",
    objective: agent.objective ?? "",
    attempt_number: String(attemptNumber),
    is_returning_contact: memory && memory.call_count > 0 ? "true" : "false",
    prior_call_count: String(memory?.call_count ?? 0),
    // The compressed relationship memory the agent uses to continue naturally.
    memory_summary: memory?.summary ?? "",
    // Structured facts flattened for prompt convenience.
    known_facts: memory ? JSON.stringify(memory.facts ?? {}) : "{}",
  };
}

/**
 * WRITE: compress the latest call into the rolling memory and persist it.
 * Uses the service-role Supabase client (called from the engine/webhook).
 */
export async function updateMemoryAfterCall(
  supabase: SupabaseClient,
  params: {
    workspaceId: string;
    agentId: string;
    contactId: string;
    callId: string;
    agentObjective: string | null;
    priorMemory: AgentMemory | null;
    transcript: string | null;
    summary: string | null;
    outcome: string;
  }
): Promise<void> {
  const { priorMemory } = params;
  const newSummary = await summarizeForMemory({
    objective: params.agentObjective,
    priorSummary: priorMemory?.summary ?? "",
    transcript: params.transcript,
    callSummary: params.summary,
    outcome: params.outcome,
  });

  // Durable structured facts. Unlike `summary` (a rolling, intentionally lossy
  // re-compression), facts are MERGED forward: a value learned on call 1 is
  // retained across every later call unless a newer call updates it. This is
  // what lets the agent remember concrete details over a long nurture.
  const newFacts = await extractFacts({
    priorFacts: priorMemory?.facts ?? {},
    transcript: params.transcript,
    callSummary: params.summary,
    outcome: params.outcome,
  });

  const callCount = (priorMemory?.call_count ?? 0) + 1;

  await supabase
    .from("agent_memory")
    .upsert(
      {
        workspace_id: params.workspaceId,
        agent_id: params.agentId,
        contact_id: params.contactId,
        summary: newSummary,
        facts: newFacts,
        objective_state: priorMemory?.objective_state ?? {},
        call_count: callCount,
        last_call_id: params.callId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id,contact_id" }
    );
}

interface SummarizeInput {
  objective: string | null;
  priorSummary: string;
  transcript: string | null;
  callSummary: string | null;
  outcome: string;
}

/**
 * Compress the conversation into a forward-looking memory note. Wire an LLM
 * here for production quality; the fallback keeps the scaffold runnable.
 */
async function summarizeForMemory(input: SummarizeInput): Promise<string> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await llmSummarize(input);
    } catch {
      // fall through to deterministic fallback
    }
  }
  const parts = [
    input.priorSummary && `Previously: ${input.priorSummary}`,
    `Last call outcome: ${input.outcome}.`,
    input.callSummary && `What happened: ${input.callSummary}`,
    input.objective && `Objective remains: ${input.objective}.`,
  ].filter(Boolean);
  // Cap growth so the memory stays prompt-sized.
  return parts.join(" ").slice(0, 1500);
}

async function llmSummarize(input: SummarizeInput): Promise<string> {
  const prompt = [
    "You maintain a rolling memory for an AI phone agent calling the same contact over time.",
    `The agent's standing objective: ${input.objective ?? "n/a"}.`,
    `Existing memory: ${input.priorSummary || "(none)"}.`,
    `Most recent call outcome: ${input.outcome}.`,
    `Most recent call summary: ${input.callSummary ?? "(none)"}.`,
    input.transcript ? `Transcript:\n${input.transcript.slice(0, 6000)}` : "",
    "",
    "Write an updated memory in 4-6 sentences the agent can read before the NEXT call.",
    "Lead with the personal connection: name any hobbies, family, life events, or small-talk the contact shared (e.g. they practice karate) so the agent can pick the relationship back up naturally.",
    "Then capture: stated preferences/objections, commitments made, and the best next step toward the objective. Be concrete and never drop a personal detail the contact volunteered. No preamble.",
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM summarize ${res.status}`);
  const data = (await res.json()) as any;
  return (data.content?.[0]?.text ?? "").trim();
}

// =====================================================================
// Durable fact extraction.
//
// The summary is a rolling, lossy note. Facts are the opposite: a fixed
// schema of concrete details that, once learned, persist across all later
// calls. Each call we ask the LLM for an updated reading of these fields,
// then MERGE it over the prior facts so a field is only ever overwritten
// by a newer non-empty value — never wiped because a later call didn't
// happen to mention it.
// =====================================================================

// Personal / relationship facts. These are vertical-agnostic and exist so the
// agent can build genuine rapport across calls — remembering hobbies, family,
// life events, and how the person likes to be treated. A contact mentioning
// "I'm off to karate" lands in `personal_interests`; "my daughter's graduating"
// in `family_details`. Kept separate from the business fields below so the
// rapport layer is reusable for any client vertical, not just probate.
export const PERSONAL_FACT_KEYS = [
  "personal_interests", // hobbies, sports, passions (e.g. "practices karate")
  "family_details", // spouse, kids, relatives, pets the contact mentions
  "life_events", // moves, jobs, retirement, health, milestones
  "preferences", // how they like to be contacted / talked to
  "rapport_notes", // small-talk hooks, jokes, shared ground to revisit
] as const;

// Business / qualification facts. Probate-leaning today (the live vertical) but
// extend freely as new verticals come online. These drive the objective; the
// personal keys above drive the relationship.
export const BUSINESS_FACT_KEYS = [
  "probate_status",
  "executor_status",
  "motivation",
  "timeline",
  "property_condition",
  "repairs_needed",
  "occupancy_status",
  "realtor_involved",
  "appointment_status",
  "email",
  "best_phone",
  "best_call_window",
  "emotional_tone",
] as const;

/** The structured fields the agent tries to keep current for each contact. */
export const FACT_KEYS = [
  ...PERSONAL_FACT_KEYS,
  ...BUSINESS_FACT_KEYS,
] as const;

interface ExtractFactsInput {
  priorFacts: Record<string, unknown>;
  transcript: string | null;
  callSummary: string | null;
  outcome: string;
}

async function extractFacts(
  input: ExtractFactsInput
): Promise<Record<string, unknown>> {
  const prior = input.priorFacts ?? {};
  // Without an LLM we can't reliably parse free-text into structured facts,
  // so we preserve what we already have rather than guessing (and never lose it).
  if (!process.env.ANTHROPIC_API_KEY) return prior;
  try {
    const extracted = await llmExtractFacts(input);
    return mergeFacts(prior, extracted);
  } catch {
    return prior;
  }
}

/**
 * Overlay newly extracted values onto prior facts. A value is only applied
 * when it is present and meaningful — blank/"unknown"/"null"/"n/a" readings
 * are ignored so an uninformative call never erases a known fact.
 */
function mergeFacts(
  prior: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...prior };
  const empties = new Set(["", "unknown", "null", "n/a", "none", "not mentioned"]);
  for (const key of FACT_KEYS) {
    const raw = next?.[key];
    if (raw == null) continue;
    const val = String(raw).trim();
    if (val === "" || empties.has(val.toLowerCase())) continue;
    merged[key] = val;
  }
  return merged;
}

async function llmExtractFacts(
  input: ExtractFactsInput
): Promise<Record<string, unknown>> {
  const prompt = [
    "You maintain a structured fact sheet for an AI phone agent that calls the same contact repeatedly and is trying to build a real, ongoing relationship with them.",
    "Given the existing fact sheet and the most recent call, return the UPDATED fact sheet.",
    "",
    `Existing fact sheet (JSON): ${JSON.stringify(input.priorFacts ?? {})}`,
    `Most recent call outcome: ${input.outcome}.`,
    `Most recent call summary: ${input.callSummary ?? "(none)"}.`,
    input.transcript ? `Transcript:\n${input.transcript.slice(0, 6000)}` : "",
    "",
    "Capture TWO kinds of information:",
    "1. PERSONAL / RAPPORT details — anything that helps the agent connect like a person who remembers them:",
    "   personal_interests (hobbies, sports, passions — e.g. 'practices karate'), family_details (spouse, kids, pets), life_events (moves, jobs, health, milestones), preferences (how they like to be contacted/spoken to), rapport_notes (small-talk hooks, jokes, shared ground to bring up next time).",
    "2. BUSINESS / QUALIFICATION details relevant to the agent's objective (e.g. for a probate/real-estate call: probate_status, executor_status, motivation, timeline, property_condition, repairs_needed, occupancy_status, realtor_involved, appointment_status), plus contact logistics: email, best_phone, best_call_window, emotional_tone.",
    "",
    "Rules:",
    "- Always capture personal/rapport details when the contact volunteers them, even in passing ('I have to go to karate' -> personal_interests). These matter as much as the business fields.",
    "- Keep every existing value unless the latest call clearly updates it.",
    "- Only fill a field if the call gives real information for it; otherwise omit the key entirely.",
    "- Each value must be a short string (a few words).",
    `- Allowed keys ONLY: ${FACT_KEYS.join(", ")}.`,
    "- Respond with a single minified JSON object and nothing else. No prose, no code fences.",
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`LLM extract-facts ${res.status}`);
  const data = (await res.json()) as any;
  const text: string = data.content?.[0]?.text ?? "";
  return parseFactsJson(text);
}

/** Defensively pull the JSON object out of the model's reply. */
function parseFactsJson(text: string): Record<string, unknown> {
  if (!text) return {};
  let candidate = text.trim();
  // Strip ```json ... ``` fences if the model added them.
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  // Fall back to the first {...} block.
  if (!candidate.startsWith("{")) {
    const brace = candidate.match(/\{[\s\S]*\}/);
    if (brace) candidate = brace[0];
  }
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
