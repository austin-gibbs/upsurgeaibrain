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

  const callCount = (priorMemory?.call_count ?? 0) + 1;

  await supabase
    .from("agent_memory")
    .upsert(
      {
        workspace_id: params.workspaceId,
        agent_id: params.agentId,
        contact_id: params.contactId,
        summary: newSummary,
        facts: priorMemory?.facts ?? {},
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
    "Capture: rapport, stated preferences/objections, commitments made, and the best next step toward the objective. Be concrete. No preamble.",
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
