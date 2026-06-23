// =====================================================================
// Normalize Retell list-calls items and join with local DB call rows.
// =====================================================================
import type { RetellCallListItem } from "@/lib/retell/client";
import type { NormalizedCallRow } from "@/lib/reporting/aggregate";
import type { AgentDirection } from "@/types";

export interface DbCallJoinRow {
  retell_call_id: string | null;
  agent_id: string;
  crm_contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  to_number: string;
  outcome: string | null;
  completed_at: string | null;
  direction: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  retell_agent_id: string | null;
  direction: AgentDirection;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function extractOutcome(item: RetellCallListItem): string | null {
  const analysis = item.call_analysis;
  if (!analysis) return null;
  const custom = analysis.custom_analysis_data ?? {};
  return (
    str(custom.call_outcome) ??
    str(analysis.call_outcome) ??
    (analysis.in_voicemail ? "voicemail" : null)
  );
}

function extractPhone(item: RetellCallListItem, direction: AgentDirection): string | null {
  if (direction === "inbound") return item.from_number ?? null;
  return item.to_number ?? item.from_number ?? null;
}

export function normalizeRetellCall(
  item: RetellCallListItem,
  agentByRetellId: Map<string, AgentMeta>,
  dbByRetellId: Map<string, DbCallJoinRow>
): NormalizedCallRow | null {
  const callId = str(item.call_id);
  if (!callId) return null;

  const db = dbByRetellId.get(callId);
  const agent =
    (item.agent_id ? agentByRetellId.get(item.agent_id) : undefined) ??
    (db ? { id: db.agent_id, name: null, retell_agent_id: item.agent_id ?? null, direction: db.direction as AgentDirection } : undefined);

  const direction: AgentDirection =
    (item.direction as AgentDirection) ??
    (db?.direction as AgentDirection) ??
    agent?.direction ??
    "outbound";

  const analysis = item.call_analysis;
  const durationSeconds = Math.round(
    (item.duration_ms ?? (item.call_cost?.total_duration_seconds ?? 0) * 1000) / 1000
  );

  const callerName =
    str(analysis?.custom_analysis_data?.caller_full_name) ??
    db?.contact_name ??
    null;
  const callerEmail =
    str(analysis?.custom_analysis_data?.caller_email) ??
    db?.contact_email ??
    null;

  return {
    retellCallId: callId,
    agentId: agent?.id ?? db?.agent_id ?? null,
    agentName: agent?.name ?? null,
    direction,
    startTimestamp: item.start_timestamp ?? null,
    completedAt: db?.completed_at ?? (item.end_timestamp ? new Date(item.end_timestamp).toISOString() : null),
    durationSeconds,
    fromNumber: item.from_number ?? null,
    toNumber: item.to_number ?? db?.to_number ?? null,
    phone: extractPhone(item, direction),
    contactName: callerName,
    contactEmail: callerEmail,
    crmContactId: db?.crm_contact_id ?? null,
    recordingUrl: item.recording_url ?? null,
    summary: analysis?.call_summary ?? null,
    outcome: db?.outcome ?? extractOutcome(item),
    callSuccessful: analysis?.call_successful ?? null,
    userSentiment: analysis?.user_sentiment ?? null,
    inVoicemail: analysis?.in_voicemail === true,
    disconnectionReason: item.disconnection_reason ?? null,
    cost: item.call_cost?.combined_cost ?? 0,
    latencyP50Ms: item.latency?.e2e?.p50 ?? null,
    latencyP90Ms: item.latency?.e2e?.p90 ?? null,
  };
}

export function buildAgentRetellMap(agents: AgentMeta[]): Map<string, AgentMeta> {
  const map = new Map<string, AgentMeta>();
  for (const a of agents) {
    if (a.retell_agent_id) map.set(a.retell_agent_id, a);
  }
  return map;
}

export function buildDbCallMap(rows: DbCallJoinRow[]): Map<string, DbCallJoinRow> {
  const map = new Map<string, DbCallJoinRow>();
  for (const r of rows) {
    if (r.retell_call_id) map.set(r.retell_call_id, r);
  }
  return map;
}

export function groupAgentsByRetellKey(
  agents: Array<AgentMeta & { retell_credentials_encrypted?: string | null }>
): Map<string, typeof agents> {
  const groups = new Map<string, typeof agents>();
  for (const a of agents) {
    const key = a.retell_credentials_encrypted ? `agent:${a.id}` : "env";
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  return groups;
}
