// =====================================================================
// Sample call context for the console's "Test Push".
//
// A test push has to send the SAME body production sends, only with obviously
// fake values, so a CRM (HighLevel Inbound Webhook, Zapier, a custom endpoint)
// can be mapped field-by-field before a single real call is placed. That means
// the sample can't be a fixed blob: the fields a client's CRM cares about are
// the ones THIS trigger reads, so they're derived from the trigger itself —
//   * every condition field gets a value that SATISFIES that condition,
//   * every {{placeholder}} in the message/payload template gets a value,
//   * the link_type field gets a type that exists in the workspace link map,
//     so link_url resolves instead of arriving null.
// Fake data is prefixed/labelled so nobody mistakes a test push for a lead.
//
// Pure (no I/O) and unit-tested in sample-context.test.ts.
// =====================================================================
import { triggerMatches } from "./conditions";
import type {
  AutomationCondition,
  AutomationEvalContext,
  AutomationTrigger,
} from "./types";
import type { CallOutcome } from "@/types";

/** The fake lead every test push is sent as. Never a real contact. */
export const SAMPLE_CONTACT = {
  first_name: "Test",
  full_name: "Test Testerson",
  email: "test.testerson@example.com",
  // 555-01xx is the reserved fictitious range — safe if a CRM auto-texts it.
  phone: "+15555550123",
} as const;

const SAMPLE_OUTCOME: CallOutcome = "appointment";
const SAMPLE_SUMMARY =
  "TEST PUSH from UpSurge — this is not a real call. Test Testerson asked for the " +
  "information to be sent over and agreed to a follow-up.";
const SAMPLE_TRANSCRIPT =
  "Agent: Hi Test, this is a test push from UpSurge.\n" +
  "User: Great — send me the info and let's talk Thursday.";
/** Obviously-fake recording so a CRM can map recording_url before any real call. */
export const SAMPLE_RECORDING_URL = "https://example.com/test-recording.wav";
const SAMPLE_APPOINTMENT_TIME = "Thursday at 3:00 PM (test)";
/** Fallback link_type when the workspace link map is still empty. */
const SAMPLE_LINK_TYPE = "buyer_guide";

/** Mirrors CallOutcome — used to ignore a condition value that isn't an outcome. */
const KNOWN_OUTCOMES: readonly string[] = [
  "appointment",
  "interested_no_appointment",
  "follow_up",
  "not_interested",
  "dnd",
  "no_answer_voicemail",
  "error",
];

/** Condition/template names that resolve from call context, not analysis data. */
const PSEUDO_FIELDS = new Set(["outcome", "summary", "transcript", "recording_url"]);
/** Template roots that aren't analysis fields (see render.ts). */
const TEMPLATE_ROOTS = new Set(["contact", "link", "outcome", "summary", "transcript", "recording_url"]);

export type SampleTrigger = Pick<
  AutomationTrigger,
  "match_type" | "conditions" | "action_config"
> & {
  // Optional so a freshly-validated create payload (where the outcome gate may
  // be omitted entirely) can be tested without being reshaped first.
  only_outcomes?: string[] | null;
};

export interface SampleContextOptions {
  /** link_types mapped for the workspace, so a "from the call" link resolves. */
  linkTypes?: string[];
}

export interface SampleContextResult {
  ctx: AutomationEvalContext;
  /** Whether the sample satisfies the trigger's own conditions + outcome gate. */
  matches: boolean;
}

function isOutcome(value: string): value is CallOutcome {
  return KNOWN_OUTCOMES.includes(value);
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** First entry of an `in` value, which may be an array or a comma string. */
function firstOf(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? asText(value[0]).trim() : "";
  return asText(value).split(",")[0]?.trim() ?? "";
}

function placeholderFor(field: string): string {
  return `test_${field}`;
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && asText(value) !== "";
}

/** A value for `field` that makes `condition` true. */
function sampleValueFor(field: string, condition: AutomationCondition): unknown {
  switch (condition.operator) {
    case "is_true":
      return true;
    case "is_false":
      return false;
    case "eq":
      return asText(condition.value);
    case "neq": {
      const avoid = asText(condition.value).trim().toLowerCase();
      const sample = placeholderFor(field);
      return sample.toLowerCase() === avoid ? `${sample}_2` : sample;
    }
    case "contains":
      return `test ${asText(condition.value)}`;
    case "in":
      return firstOf(condition.value);
    default:
      return placeholderFor(field);
  }
}

/** Bend the sample summary/transcript so a condition on it still matches. */
function shapeText(base: string | null, condition: AutomationCondition): string | null {
  switch (condition.operator) {
    case "eq":
      return asText(condition.value);
    case "contains":
      return `${base ?? ""} ${asText(condition.value)}`.trim();
    case "in":
      return firstOf(condition.value);
    case "not_exists":
    case "is_false":
      return null;
    default:
      return base;
  }
}

/**
 * The outcome to test with: the first allowed outcome when the trigger gates on
 * `only_outcomes`, else an explicit `outcome` condition, else a sensible default.
 */
function pickOutcome(trigger: SampleTrigger): CallOutcome {
  const gate = (trigger.only_outcomes ?? []).map((o) => asText(o).trim());
  let outcome: CallOutcome = gate.find(isOutcome) ?? SAMPLE_OUTCOME;

  for (const condition of trigger.conditions ?? []) {
    if (asText(condition.field).trim() !== "outcome") continue;
    const candidate =
      condition.operator === "eq"
        ? asText(condition.value).trim()
        : condition.operator === "in"
          ? firstOf(condition.value)
          : "";
    // Never let a condition pick an outcome the gate would reject.
    if (isOutcome(candidate) && (gate.length === 0 || gate.includes(candidate))) {
      outcome = candidate;
    }
  }
  return outcome;
}

/** Analysis field names referenced by the message/payload templates. */
function templateFields(trigger: SampleTrigger): string[] {
  const cfg = trigger.action_config ?? {};
  const sources = [
    cfg.message_template ?? "",
    cfg.payload_template ? JSON.stringify(cfg.payload_template) : "",
  ].join(" ");

  const fields: string[] = [];
  for (const match of sources.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const parts = match[1].split(".");
    const head = parts[0];
    if (head === "fields") {
      if (parts[1]) fields.push(parts[1]);
    } else if (!TEMPLATE_ROOTS.has(head)) {
      fields.push(head);
    }
  }
  return fields;
}

/** Build the fake call context a test push is rendered from. */
export function buildSampleContext(
  trigger: SampleTrigger,
  opts: SampleContextOptions = {}
): SampleContextResult {
  const conditions = trigger.conditions ?? [];
  const outcome = pickOutcome(trigger);

  let summary: string | null = SAMPLE_SUMMARY;
  let transcript: string | null = SAMPLE_TRANSCRIPT;

  // Every provisioned agent emits these two analysis fields (see
  // DEFAULT_POST_CALL_ANALYSIS_DATA), so a real payload always carries them.
  const customFields: Record<string, unknown> = {
    call_outcome: outcome,
    appointment_time: outcome === "appointment" ? SAMPLE_APPOINTMENT_TIME : "",
  };
  // Fields a condition requires to be absent must stay absent.
  const absent = new Set<string>();

  for (const condition of conditions) {
    const field = asText(condition.field).trim();
    if (!field) continue;
    if (field === "summary") {
      summary = shapeText(summary, condition);
      continue;
    }
    if (field === "transcript") {
      transcript = shapeText(transcript, condition);
      continue;
    }
    if (PSEUDO_FIELDS.has(field)) continue;

    if (condition.operator === "not_exists") {
      delete customFields[field];
      absent.add(field);
      continue;
    }
    customFields[field] = sampleValueFor(field, condition);
  }

  // The link the action attaches: prefer a link_type that's actually mapped for
  // this workspace, so the payload carries a real link_url to map against.
  const linkTypeField = trigger.action_config?.link_type_field;
  if (linkTypeField && !absent.has(linkTypeField) && !hasValue(customFields[linkTypeField])) {
    customFields[linkTypeField] = opts.linkTypes?.[0] ?? SAMPLE_LINK_TYPE;
  }

  // Nothing the CRM is asked to map should arrive empty.
  for (const field of templateFields(trigger)) {
    if (absent.has(field) || PSEUDO_FIELDS.has(field)) continue;
    if (!hasValue(customFields[field])) customFields[field] = placeholderFor(field);
  }

  const ctx: AutomationEvalContext = {
    outcome,
    summary,
    transcript,
    recordingUrl: SAMPLE_RECORDING_URL,
    customFields,
    contact: { ...SAMPLE_CONTACT },
  };

  return {
    ctx,
    matches: triggerMatches(
      {
        match_type: trigger.match_type,
        conditions,
        only_outcomes: trigger.only_outcomes ?? null,
      },
      ctx
    ),
  };
}
