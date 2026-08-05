// =====================================================================
// Inbound outcome classification + route resolution.
//
// Inbound outcomes are a separate taxonomy from the outbound CallOutcome
// enum: they never drive cadence/terminality, and extending the outbound
// enum would leak inbound-only values into every outbound picker.
// =====================================================================
import type { AgentInboundConfig, AgentInboundRoute, InboundOutcome } from "@/types";

/** Canonical inbound outcomes — shared by classifier, Zod schema, and UI. */
export const INBOUND_OUTCOMES = [
  "appointment_booked",
  "hot_lead",
  "interested",
  "general_inquiry",
  "existing_client",
  "support_request",
  "transferred",
  "message_taken",
  "not_interested",
  "wrong_number",
  "spam",
  "unknown",
] as const satisfies readonly InboundOutcome[];

const INBOUND_OUTCOME_SET = new Set<string>(INBOUND_OUTCOMES);

const ALIAS: Record<string, InboundOutcome> = {
  appointment_booked: "appointment_booked",
  appointment: "appointment_booked",
  booked: "appointment_booked",
  appointment_set: "appointment_booked",
  hot_lead: "hot_lead",
  hot: "hot_lead",
  hotlead: "hot_lead",
  interested: "interested",
  interested_no_appointment: "interested",
  follow_up: "interested",
  general_inquiry: "general_inquiry",
  inquiry: "general_inquiry",
  general: "general_inquiry",
  existing_client: "existing_client",
  existing: "existing_client",
  client: "existing_client",
  support_request: "support_request",
  support: "support_request",
  transferred: "transferred",
  transfer: "transferred",
  message_taken: "message_taken",
  message: "message_taken",
  voicemail: "message_taken",
  not_interested: "not_interested",
  notinterested: "not_interested",
  wrong_number: "wrong_number",
  wrongnumber: "wrong_number",
  spam: "spam",
  robocall: "spam",
  unknown: "unknown",
};

/**
 * Normalize a free-text / outbound outcome string to the inbound canonical
 * taxonomy when possible. Used by post-call automation gating so a trigger
 * written with outbound outcomes (appointment, interested_no_appointment)
 * still matches inbound calls (appointment_booked, interested).
 */
export function normalizeOutcomeAlias(raw: string | null | undefined): string {
  const co = String(raw ?? "").toLowerCase().trim();
  if (!co) return "";
  const norm = co.split(" ").join("_").split("-").join("_");
  return ALIAS[norm] ?? norm;
}

/**
 * Does an only_outcomes entry match a call outcome?
 *
 * Outbound: exact string match (byte-identical to pre-0035 behaviour).
 * Inbound: both sides are canonicalized through the alias map so
 * `appointment` matches `appointment_booked`, etc.
 */
export function outcomeMatchesGate(
  callOutcome: string,
  allowed: string[],
  direction: "inbound" | "outbound" | undefined
): boolean {
  if (!allowed.length) return true;
  if (direction === "inbound") {
    const callCanon = normalizeOutcomeAlias(callOutcome);
    return allowed.some((o) => normalizeOutcomeAlias(o) === callCanon);
  }
  return allowed.includes(callOutcome);
}

export interface ClassifyInboundInput {
  /** Free-text outcome from Retell custom analysis data. */
  rawOutcome: string | null | undefined;
}

/**
 * Map Retell's free-text inbound outcome to a canonical InboundOutcome.
 * Unrecognized values fall back to `unknown` (with a warn) so a prompt
 * change can never silently drop a lead — unknown still gets the baseline
 * tag and the catch-all stage.
 */
export function classifyInboundOutcome({
  rawOutcome,
}: ClassifyInboundInput): InboundOutcome {
  const co = String(rawOutcome ?? "").toLowerCase().trim();
  if (!co) return "unknown";
  const norm = co.split(" ").join("_").split("-").join("_");
  const mapped = ALIAS[norm];
  if (mapped) return mapped;
  if (INBOUND_OUTCOME_SET.has(norm)) return norm as InboundOutcome;
  console.warn(
    `[inbound-outcome] unrecognized Retell outcome "${rawOutcome}" (normalized "${norm}") — defaulting to unknown. Add it to the ALIAS map if it's a real outcome.`
  );
  return "unknown";
}

const DISPLAY_LABELS: Partial<Record<InboundOutcome, string>> = {
  appointment_booked: "Appointment Booked",
  hot_lead: "Hot Lead",
  general_inquiry: "General Inquiry",
  existing_client: "Existing Client",
  support_request: "Support Request",
  message_taken: "Message Taken",
  not_interested: "Not Interested",
  wrong_number: "Wrong Number",
};

/** Human-readable label for UI and CRM notes. */
export function inboundOutcomeLabel(outcome: InboundOutcome | string): string {
  if (outcome in DISPLAY_LABELS) {
    return DISPLAY_LABELS[outcome as InboundOutcome]!;
  }
  return String(outcome)
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Resolved routing target after applying exact → '*' → config-default precedence. */
export interface ResolvedInboundRoute {
  /** The agent_inbound_routes row that matched, if any. */
  route: AgentInboundRoute | null;
  pipelineId: string | null;
  stageId: string | null;
  pipelineName: string | null;
  stageName: string | null;
  opportunityStatus: "open" | "won" | "lost" | "abandoned" | null;
  tag: string | null;
  removeTags: string[];
  /** Where the pipeline/stage came from. */
  source: "exact" | "catch_all" | "config_default" | "none";
}

/**
 * Prefer the exact outcome row, then `'*'`, then the config's default_pipeline_*.
 * Tag / remove_tags always come from the matched route row (exact or '*');
 * the config default only supplies pipeline/stage when no route matched.
 */
export function resolveInboundRoute(
  routes: AgentInboundRoute[],
  outcome: InboundOutcome | string,
  config: Pick<
    AgentInboundConfig,
    | "default_pipeline_id"
    | "default_pipeline_stage_id"
    | "default_pipeline_name"
    | "default_stage_name"
  > | null
): ResolvedInboundRoute {
  const exact = routes.find((r) => r.outcome === outcome) ?? null;
  const catchAll = routes.find((r) => r.outcome === "*") ?? null;
  const matched = exact ?? catchAll;
  const source: ResolvedInboundRoute["source"] = exact
    ? "exact"
    : catchAll
      ? "catch_all"
      : "none";

  if (matched?.pipeline_id && matched?.pipeline_stage_id) {
    return {
      route: matched,
      pipelineId: matched.pipeline_id,
      stageId: matched.pipeline_stage_id,
      pipelineName: matched.pipeline_name,
      stageName: matched.stage_name,
      opportunityStatus: matched.opportunity_status ?? null,
      tag: matched.tag,
      removeTags: matched.remove_tags ?? [],
      source,
    };
  }

  // Route matched for tags but had no stage — still apply tags; fall through
  // to config default for pipeline.
  if (config?.default_pipeline_id?.trim() && config?.default_pipeline_stage_id?.trim()) {
    return {
      route: matched,
      pipelineId: config.default_pipeline_id,
      stageId: config.default_pipeline_stage_id,
      pipelineName: config.default_pipeline_name,
      stageName: config.default_stage_name,
      opportunityStatus: matched?.opportunity_status ?? null,
      tag: matched?.tag ?? null,
      removeTags: matched?.remove_tags ?? [],
      source: matched ? source : "config_default",
    };
  }

  return {
    route: matched,
    pipelineId: null,
    stageId: null,
    pipelineName: null,
    stageName: null,
    opportunityStatus: matched?.opportunity_status ?? null,
    tag: matched?.tag ?? null,
    removeTags: matched?.remove_tags ?? [],
    source: matched ? source : "none",
  };
}
