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
  in_voicemail?: boolean | null;
  summary?: string | null;
  completed_at: string | null;
  direction: string;
}

export interface StoredCallJoinRow extends DbCallJoinRow {
  id: string;
  raw_payload: unknown;
  queued_at: string;
  dialed_at: string | null;
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

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function rawCallFromPayload(raw: unknown): Record<string, unknown> {
  const root = record(raw);
  return record(root.call ?? root);
}

function analysisFromCall(call: Record<string, unknown>): Record<string, unknown> {
  return record(call.call_analysis);
}

function customFromAnalysis(analysis: Record<string, unknown>): Record<string, unknown> {
  return record(analysis.custom_analysis_data);
}

function extractOutcome(item: RetellCallListItem): string | null {
  const analysis = item.call_analysis;
  if (!analysis) return null;
  const custom = analysis.custom_analysis_data ?? {};
  return (
    str(custom.call_outcome) ??
    str(analysis.call_outcome) ??
    (analysis.in_voicemail ? "no_answer_voicemail" : null)
  );
}

function extractOutcomeFromRawCall(
  call: Record<string, unknown>,
  inVoicemail: boolean
): string | null {
  const analysis = analysisFromCall(call);
  const custom = customFromAnalysis(analysis);
  return (
    str(custom.call_outcome) ??
    str(analysis.call_outcome) ??
    (inVoicemail ? "no_answer_voicemail" : null)
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
    summary: db?.summary ?? analysis?.call_summary ?? null,
    outcome: db?.outcome ?? extractOutcome(item),
    callSuccessful: analysis?.call_successful ?? null,
    userSentiment: analysis?.user_sentiment ?? null,
    inVoicemail: db?.in_voicemail ?? analysis?.in_voicemail === true,
    disconnectionReason: item.disconnection_reason ?? null,
    cost: item.call_cost?.combined_cost ?? 0,
    latencyP50Ms: item.latency?.e2e?.p50 ?? null,
    latencyP90Ms: item.latency?.e2e?.p90 ?? null,
  };
}

export function normalizeStoredCall(
  row: StoredCallJoinRow,
  agentById: Map<string, AgentMeta>
): NormalizedCallRow {
  const call = rawCallFromPayload(row.raw_payload);
  const analysis = analysisFromCall(call);
  const custom = customFromAnalysis(analysis);
  const cost = record(call.call_cost);
  const latency = record(record(call.latency).e2e);
  const agent = agentById.get(row.agent_id);
  const direction: AgentDirection =
    (str(call.direction) as AgentDirection | null) ??
    (row.direction as AgentDirection) ??
    agent?.direction ??
    "outbound";
  const inVoicemail =
    row.in_voicemail ??
    bool(analysis.in_voicemail) ??
    bool(custom.in_voicemail) ??
    false;
  const durationMs =
    num(call.duration_ms) ?? (num(cost.total_duration_seconds) ?? 0) * 1000;
  const startTimestamp =
    num(call.start_timestamp) ??
    (row.completed_at ? new Date(row.completed_at).getTime() : null) ??
    (row.dialed_at ? new Date(row.dialed_at).getTime() : null) ??
    new Date(row.queued_at).getTime();
  const fromNumber = str(call.from_number);
  const toNumber = str(call.to_number) ?? row.to_number;

  return {
    retellCallId: str(call.call_id) ?? row.retell_call_id ?? row.id,
    agentId: row.agent_id,
    agentName: agent?.name ?? null,
    direction,
    startTimestamp,
    completedAt:
      row.completed_at ??
      (num(call.end_timestamp) ? new Date(num(call.end_timestamp) as number).toISOString() : null),
    durationSeconds: Math.round(durationMs / 1000),
    fromNumber,
    toNumber,
    phone: extractPhone(
      {
        call_id: str(call.call_id) ?? row.retell_call_id ?? row.id,
        from_number: fromNumber ?? undefined,
        to_number: toNumber ?? undefined,
      },
      direction
    ),
    contactName: str(custom.caller_full_name) ?? row.contact_name,
    contactEmail: str(custom.caller_email) ?? row.contact_email,
    crmContactId: row.crm_contact_id,
    recordingUrl: str(call.recording_url),
    summary: row.summary ?? str(analysis.call_summary),
    outcome: row.outcome ?? extractOutcomeFromRawCall(call, inVoicemail),
    callSuccessful: bool(analysis.call_successful),
    userSentiment: str(analysis.user_sentiment),
    inVoicemail,
    disconnectionReason: str(call.disconnection_reason),
    cost: num(cost.combined_cost) ?? 0,
    latencyP50Ms: num(latency.p50),
    latencyP90Ms: num(latency.p90),
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
