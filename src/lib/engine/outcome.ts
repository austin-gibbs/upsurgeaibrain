// =====================================================================
// Outcome classification.
//
// Ports the production n8n "Extract Call Data" logic (verified end-to-end
// against 20 cases) into typed code: normalize Retell's free-text outcome
// through an alias map and resolve to one of the canonical outcomes.
// No Answer and Voicemail are a single outcome (no_answer_voicemail).
// =====================================================================
import type { CallOutcome } from "@/types";

const ALIAS: Record<string, CallOutcome> = {
  noanswer: "no_answer_voicemail",
  no_answer: "no_answer_voicemail",
  no_answer_voicemail: "no_answer_voicemail",
  voicemail: "no_answer_voicemail",
  vm: "no_answer_voicemail",
  appointment: "appointment",
  appointment_set: "appointment",
  booked: "appointment",
  not_interested: "not_interested",
  notinterested: "not_interested",
  dnd: "dnd",
  do_not_call: "dnd",
  do_not_disturb: "dnd",
  remove: "dnd",
  interested_no_appointment: "interested_no_appointment",
  interested: "interested_no_appointment",
  follow_up: "follow_up",
  followup: "follow_up",
  callback: "follow_up",
};

export interface ClassifyInput {
  /** Free-text outcome from Retell custom analysis data. */
  rawOutcome: string | null | undefined;
  inVoicemail: boolean;
}

export function classifyOutcome({ rawOutcome, inVoicemail }: ClassifyInput): CallOutcome {
  const co = String(rawOutcome ?? "no_answer").toLowerCase().trim();
  const norm = co.split(" ").join("_").split("-").join("_");
  let eff: CallOutcome | undefined = ALIAS[norm];
  // Unknown free-text outcomes fall back to no_answer_voicemail (safe: keeps
  // calling). Log the fallthrough so a NEW Retell outcome string isn't silently
  // swallowed — otherwise a real "appointment"-class result could be miscounted
  // as no-answer and the contact would keep getting dialed.
  if (!eff) {
    if (norm && norm !== "no_answer") {
      console.warn(
        `[outcome] unrecognized Retell outcome "${rawOutcome}" (normalized "${norm}") — defaulting to no_answer_voicemail. Add it to the ALIAS map if it's a real outcome.`
      );
    }
    eff = "no_answer_voicemail";
  }
  return eff;
}

const DISPLAY_LABELS: Partial<Record<CallOutcome, string>> = {
  no_answer_voicemail: "No Answer/Voicemail",
};

/** Human-readable label for UI and CRM notes. */
export function outcomeLabel(outcome: CallOutcome): string {
  if (DISPLAY_LABELS[outcome]) return DISPLAY_LABELS[outcome]!;
  return outcome
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Pull the pieces we need out of a Retell `call_analyzed` webhook body.
 * Field paths follow Retell's documented call object; we read the custom
 * analysis fields the agent is configured to emit.
 */
export function extractFromRetellPayload(body: any): {
  callId: string;
  rawOutcome: string | null;
  inVoicemail: boolean;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  durationSeconds: number;
  fromNumber: string | null;
  metadata: Record<string, string>;
} {
  const call = body?.call ?? body ?? {};
  const analysis = call.call_analysis ?? {};
  const custom = analysis.custom_analysis_data ?? {};
  return {
    callId: String(call.call_id ?? ""),
    rawOutcome: custom.call_outcome ?? analysis.call_outcome ?? null,
    inVoicemail: analysis.in_voicemail === true || custom.in_voicemail === true,
    summary: analysis.call_summary ?? null,
    transcript: call.transcript ?? null,
    recordingUrl: call.recording_url ?? null,
    durationSeconds: Math.round((call.duration_ms ?? 0) / 1000),
    fromNumber: call.from_number ?? null,
    metadata: call.metadata ?? {},
  };
}
