// =====================================================================
// Form model for the /admin/automations post-call trigger editor.
//
// The API speaks the stored shape (nested action_config, typed condition
// values, string[] outcomes); form inputs need flat strings. These converters
// are the only place that translation happens, so the create form, the edit
// form, and the raw-JSON escape hatch can never drift apart.
//
// Everything here is pure — the editor stays a thin rendering layer and the
// round trip is unit-tested in trigger-draft.test.ts.
// =====================================================================

export const CONDITION_OPERATORS = [
  { value: "is_true", label: "is true", needsValue: false },
  { value: "is_false", label: "is false", needsValue: false },
  { value: "exists", label: "is present", needsValue: false },
  { value: "not_exists", label: "is empty", needsValue: false },
  { value: "eq", label: "equals", needsValue: true },
  { value: "neq", label: "does not equal", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "in", label: "is one of", needsValue: true },
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]["value"];

export function operatorNeedsValue(op: ConditionOperator): boolean {
  return CONDITION_OPERATORS.find((o) => o.value === op)?.needsValue ?? false;
}

export const ACTION_TYPES = [
  {
    value: "highlevel_sms",
    label: "HighLevel SMS",
    blurb: "POST to a HighLevel Inbound Webhook so the workflow texts the contact.",
  },
  {
    value: "webhook",
    label: "Webhook",
    blurb: "POST the call payload to any HTTPS endpoint.",
  },
  {
    value: "internal_notify",
    label: "Internal notify",
    blurb: "Record the match internally — no outbound request.",
  },
] as const;

export type ActionType = (typeof ACTION_TYPES)[number]["value"];

/** Canonical outcomes the engine classifies a call into (src/types/index.ts). */
export const CALL_OUTCOMES = [
  "appointment",
  "interested_no_appointment",
  "follow_up",
  "not_interested",
  "dnd",
  "no_answer_voicemail",
  "error",
] as const;

/** Pseudo-fields the matcher resolves from call context, not analysis data. */
export const CONTEXT_FIELDS = ["outcome", "summary", "transcript"] as const;

export type TriggerRow = {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  match_type: string;
  action_type: string;
  conditions: unknown;
  action_config: Record<string, unknown> | null;
  dedupe_window_hours: number;
  max_attempts: number;
  only_outcomes: string[] | null;
  updated_at?: string | null;
};

export type ConditionDraft = {
  field: string;
  operator: ConditionOperator;
  value: string;
};

/** How the action decides which link to attach from the workspace link map. */
export type LinkMode = "none" | "field" | "static";

export type TriggerDraft = {
  name: string;
  description: string;
  enabled: boolean;
  /** "" = every agent in the workspace. */
  agentId: string;
  matchType: "all" | "any";
  conditions: ConditionDraft[];
  actionType: ActionType;
  url: string;
  method: "POST" | "PUT" | "PATCH";
  messageTemplate: string;
  linkMode: LinkMode;
  linkTypeField: string;
  staticLinkType: string;
  /** Raw JSON text — parsed on save so a typo shows as a form error. */
  headersJson: string;
  payloadJson: string;
  dedupeWindowHours: string;
  maxAttempts: string;
  onlyOutcomes: string[];
};

export function emptyDraft(): TriggerDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    agentId: "",
    matchType: "all",
    conditions: [{ field: "link_requested", operator: "is_true", value: "" }],
    actionType: "highlevel_sms",
    url: "",
    method: "POST",
    messageTemplate:
      "Hi {{contact.first_name}}, here's the info you asked for: {{link.url}}",
    linkMode: "field",
    linkTypeField: "link_type",
    staticLinkType: "",
    headersJson: "",
    payloadJson: "",
    dedupeWindowHours: "24",
    maxAttempts: "5",
    onlyOutcomes: [],
  };
}

function conditionValueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  return String(value);
}

export function draftFromTrigger(trigger: TriggerRow): TriggerDraft {
  const base = emptyDraft();
  const config = (trigger.action_config ?? {}) as Record<string, unknown>;
  const rawConditions = Array.isArray(trigger.conditions) ? trigger.conditions : [];

  const conditions: ConditionDraft[] = rawConditions.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    const operator = String(c.operator ?? "eq") as ConditionOperator;
    return {
      field: String(c.field ?? ""),
      operator: CONDITION_OPERATORS.some((o) => o.value === operator) ? operator : "eq",
      value: conditionValueToText(c.value),
    };
  });

  const staticLinkType = typeof config.static_link_type === "string" ? config.static_link_type : "";
  const linkTypeField = typeof config.link_type_field === "string" ? config.link_type_field : "";
  const linkMode: LinkMode = staticLinkType ? "static" : linkTypeField ? "field" : "none";

  const method = String(config.method ?? "POST");

  return {
    name: trigger.name,
    description: trigger.description ?? "",
    enabled: trigger.enabled,
    agentId: trigger.agent_id ?? "",
    matchType: trigger.match_type === "any" ? "any" : "all",
    conditions,
    actionType: ACTION_TYPES.some((a) => a.value === trigger.action_type)
      ? (trigger.action_type as ActionType)
      : "webhook",
    url: typeof config.url === "string" ? config.url : "",
    method: method === "PUT" || method === "PATCH" ? method : "POST",
    messageTemplate: typeof config.message_template === "string" ? config.message_template : "",
    linkMode,
    linkTypeField,
    staticLinkType,
    headersJson: config.headers ? JSON.stringify(config.headers, null, 2) : "",
    payloadJson: config.payload_template
      ? JSON.stringify(config.payload_template, null, 2)
      : "",
    dedupeWindowHours: String(trigger.dedupe_window_hours ?? base.dedupeWindowHours),
    maxAttempts: String(trigger.max_attempts ?? base.maxAttempts),
    onlyOutcomes: trigger.only_outcomes ?? [],
  };
}

export type TriggerPayload = {
  name: string;
  description: string | null;
  enabled: boolean;
  match_type: "all" | "any";
  conditions: Array<{ field: string; operator: ConditionOperator; value?: unknown }>;
  action_type: ActionType;
  action_config: Record<string, unknown>;
  dedupe_window_hours: number;
  max_attempts: number;
  only_outcomes: string[] | null;
};

export type BuildResult =
  | { ok: true; payload: TriggerPayload }
  | { ok: false; error: string };

function parseJsonObject(
  text: string,
  label: string
): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${label} is not valid JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${label} must be a JSON object.` };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Map the draft onto the API shape without judging it. Anything unparseable is
 * dropped rather than reported — `draftToPayload` is the validating entry
 * point; this exists so the JSON view can render a half-finished draft.
 */
function buildPayload(draft: TriggerDraft): TriggerPayload {
  const conditions = draft.conditions.map((c) => {
    const field = c.field.trim();
    if (!operatorNeedsValue(c.operator)) return { field, operator: c.operator };
    const value =
      c.operator === "in"
        ? c.value
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean)
        : c.value;
    return { field, operator: c.operator, value };
  });

  const headers = parseJsonObject(draft.headersJson, "Custom headers");
  const payloadTemplate = parseJsonObject(draft.payloadJson, "Payload template");
  const url = draft.url.trim();
  const needsUrl = draft.actionType !== "internal_notify";

  // action_config is validated `.strict()` server-side, so only send the keys
  // this action actually uses — a leftover empty string would be rejected.
  const actionConfig: Record<string, unknown> = {};
  if (url) actionConfig.url = url;
  if (needsUrl && draft.method !== "POST") actionConfig.method = draft.method;
  if (draft.messageTemplate.trim()) actionConfig.message_template = draft.messageTemplate;
  if (draft.linkMode === "field" && draft.linkTypeField.trim()) {
    actionConfig.link_type_field = draft.linkTypeField.trim();
  }
  if (draft.linkMode === "static" && draft.staticLinkType.trim()) {
    actionConfig.static_link_type = draft.staticLinkType.trim();
  }
  if (headers.ok && headers.value) actionConfig.headers = headers.value;
  if (payloadTemplate.ok && payloadTemplate.value) {
    actionConfig.payload_template = payloadTemplate.value;
  }

  return {
    name: draft.name.trim(),
    description: draft.description.trim() || null,
    enabled: draft.enabled,
    match_type: draft.matchType,
    conditions,
    action_type: draft.actionType,
    action_config: actionConfig,
    dedupe_window_hours: Number(draft.dedupeWindowHours),
    max_attempts: Number(draft.maxAttempts),
    only_outcomes: draft.onlyOutcomes.length > 0 ? draft.onlyOutcomes : null,
  };
}

/**
 * Validate the draft and build the API payload. Client-side validation mirrors
 * the Zod schema so the common mistakes surface next to the field instead of
 * coming back as a 400.
 */
export function draftToPayload(draft: TriggerDraft): BuildResult {
  if (!draft.name.trim()) return { ok: false, error: "Give the automation a name." };

  for (const [i, c] of draft.conditions.entries()) {
    if (!c.field.trim()) {
      return { ok: false, error: `Condition ${i + 1} needs a field name.` };
    }
    if (operatorNeedsValue(c.operator) && !c.value.trim()) {
      return { ok: false, error: `Condition ${i + 1} needs a value to compare against.` };
    }
  }

  const headers = parseJsonObject(draft.headersJson, "Custom headers");
  if (!headers.ok) return headers;
  const payloadTemplate = parseJsonObject(draft.payloadJson, "Payload template");
  if (!payloadTemplate.ok) return payloadTemplate;

  const url = draft.url.trim();
  if (draft.actionType !== "internal_notify" && !url) {
    return { ok: false, error: "A delivery URL is required for this action type." };
  }
  if (url) {
    try {
      new URL(url);
    } catch {
      return { ok: false, error: "The delivery URL is not a valid URL." };
    }
  }

  const dedupe = Number(draft.dedupeWindowHours);
  if (!Number.isInteger(dedupe) || dedupe < 0 || dedupe > 720) {
    return { ok: false, error: "Dedupe window must be a whole number of hours from 0 to 720." };
  }
  const attempts = Number(draft.maxAttempts);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
    return { ok: false, error: "Max attempts must be a whole number from 1 to 20." };
  }

  return { ok: true, payload: buildPayload(draft) };
}

/** Serialize a draft for the JSON view, even when it isn't valid yet. */
export function draftToJson(draft: TriggerDraft): string {
  return payloadToJson(buildPayload(draft));
}

/**
 * Load a raw trigger JSON object back into the form. Powers the "Edit as JSON"
 * escape hatch and pasting a trigger from the runbook.
 */
export function draftFromPayloadJson(
  text: string,
  agentId: string
): { ok: true; draft: TriggerDraft } | { ok: false; error: string } {
  const parsed = parseJsonObject(text, "Trigger JSON");
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: false, error: "Trigger JSON is empty." };

  const raw = parsed.value;
  return {
    ok: true,
    draft: draftFromTrigger({
      id: "",
      workspace_id: "",
      agent_id: agentId || null,
      name: String(raw.name ?? ""),
      description: typeof raw.description === "string" ? raw.description : null,
      enabled: raw.enabled !== false,
      match_type: String(raw.match_type ?? "all"),
      action_type: String(raw.action_type ?? "webhook"),
      conditions: raw.conditions,
      action_config: (raw.action_config ?? {}) as Record<string, unknown>,
      dedupe_window_hours: Number(raw.dedupe_window_hours ?? 24),
      max_attempts: Number(raw.max_attempts ?? 5),
      only_outcomes: Array.isArray(raw.only_outcomes)
        ? raw.only_outcomes.map((o) => String(o))
        : null,
    }),
  };
}

/** Human-readable one-liner for a trigger's matching rule, for list rows. */
export function summarizeConditions(trigger: TriggerRow): string {
  const conditions = Array.isArray(trigger.conditions) ? trigger.conditions : [];
  if (conditions.length === 0) return "Every analyzed call";
  const joiner = trigger.match_type === "any" ? " or " : " and ";
  return conditions
    .map((raw) => {
      const c = (raw ?? {}) as Record<string, unknown>;
      const op = CONDITION_OPERATORS.find((o) => o.value === c.operator);
      const label = op?.label ?? String(c.operator ?? "");
      const value = op?.needsValue ? ` ${conditionValueToText(c.value)}` : "";
      return `${String(c.field ?? "")} ${label}${value}`.trim();
    })
    .join(joiner);
}

/** Pretty-print a trigger the way the API expects it, for the JSON editor. */
export function payloadToJson(payload: TriggerPayload): string {
  return JSON.stringify(payload, null, 2);
}
