import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { CallOutcome, Contact } from "@/types";

type DbClient = SupabaseClient<Database>;

export interface AgentContactState {
  agent_id: string;
  contact_id: string;
  attempt_count: number;
  last_called_on: string | null;
  next_eligible_on: string | null;
  is_terminal: boolean;
  terminal_outcome: CallOutcome | null;
}

export function defaultAgentContactState(
  agentId: string,
  contactId: string
): AgentContactState {
  return {
    agent_id: agentId,
    contact_id: contactId,
    attempt_count: 0,
    last_called_on: null,
    next_eligible_on: null,
    is_terminal: false,
    terminal_outcome: null,
  };
}

/** Overlay per-agent cadence state onto the shared CRM contact cache row. */
export function applyAgentContactState<T extends Contact>(
  contact: T,
  state: AgentContactState | null | undefined
): T {
  const effective = state ?? defaultAgentContactState("", contact.id);
  return {
    ...contact,
    attempt_count: effective.attempt_count,
    last_called_on: effective.last_called_on,
    next_eligible_on: effective.next_eligible_on,
    is_terminal: effective.is_terminal,
    terminal_outcome: effective.terminal_outcome,
  };
}

export async function getAgentContactState(
  supabase: DbClient,
  agentId: string,
  contactId: string
): Promise<AgentContactState> {
  const { data, error } = await supabase
    .from("agent_contact_states")
    .select(
      "agent_id, contact_id, attempt_count, last_called_on, next_eligible_on, is_terminal, terminal_outcome"
    )
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .maybeSingle<AgentContactState>();
  if (error) throw new Error(error.message);
  return data ?? defaultAgentContactState(agentId, contactId);
}

export async function ensureAgentContactStates(
  supabase: DbClient,
  agentId: string,
  contactIds: string[]
): Promise<Map<string, AgentContactState>> {
  const uniqueIds = [...new Set(contactIds)].filter(Boolean);
  const states = new Map<string, AgentContactState>();
  if (uniqueIds.length === 0) return states;

  const { data: existing, error } = await supabase
    .from("agent_contact_states")
    .select(
      "agent_id, contact_id, attempt_count, last_called_on, next_eligible_on, is_terminal, terminal_outcome"
    )
    .eq("agent_id", agentId)
    .in("contact_id", uniqueIds)
    .returns<AgentContactState[]>();
  if (error) throw new Error(error.message);

  for (const row of existing ?? []) states.set(row.contact_id, row);

  const missing = uniqueIds.filter((id) => !states.has(id));
  if (missing.length > 0) {
    const { error: upsertError } = await supabase
      .from("agent_contact_states")
      .upsert(
        missing.map((contactId) => ({
          agent_id: agentId,
          contact_id: contactId,
        })),
        { onConflict: "agent_id,contact_id", ignoreDuplicates: true }
      );
    if (upsertError) throw new Error(upsertError.message);

    for (const contactId of missing) {
      states.set(contactId, defaultAgentContactState(agentId, contactId));
    }
  }

  return states;
}

export async function updateAgentContactState(
  supabase: DbClient,
  params: {
    agentId: string;
    contactId: string;
    attemptCount?: number;
    lastCalledOn?: string | null;
    nextEligibleOn?: string | null;
    isTerminal?: boolean;
    terminalOutcome?: CallOutcome | null;
  }
): Promise<void> {
  const patch: Database["public"]["Tables"]["agent_contact_states"]["Insert"] = {
    agent_id: params.agentId,
    contact_id: params.contactId,
  };
  if (params.attemptCount != null) patch.attempt_count = params.attemptCount;
  if ("lastCalledOn" in params) patch.last_called_on = params.lastCalledOn;
  if ("nextEligibleOn" in params) patch.next_eligible_on = params.nextEligibleOn;
  if (params.isTerminal != null) patch.is_terminal = params.isTerminal;
  if ("terminalOutcome" in params) patch.terminal_outcome = params.terminalOutcome;

  const { error } = await supabase
    .from("agent_contact_states")
    .upsert(patch, { onConflict: "agent_id,contact_id" });
  if (error) throw new Error(error.message);
}
