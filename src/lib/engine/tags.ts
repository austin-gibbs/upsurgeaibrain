// =====================================================================
// Tag reconciliation.
//
// Ports the n8n "Build Outcome Tags" logic: strip the active marker and any
// prior AI outcome tag, then add the current one. Idempotent — re-running
// with the same outcome is a no-op.
// =====================================================================
import type { CallOutcome, OutcomeTag } from "@/types";

export interface TagReconcileInput {
  currentTags: string[];
  /** The full taxonomy for this workspace. */
  taxonomy: OutcomeTag[];
  outcome: CallOutcome;
  /** Tag that marks an active enrollment, removed on terminal outcomes. */
  enrollTag: string;
}

export interface TagReconcileResult {
  tags: string[];
  appliedTag: string;
  isTerminal: boolean;
}

/** Legacy CRM tags from before voicemail + no_answer were merged. */
const LEGACY_NO_ANSWER_VOICEMAIL_TAGS = new Set([
  "upsurge-voicemail-ai",
  "upsurge-noanswer-ai",
]);
const FALLBACK_NO_ANSWER_VOICEMAIL_TAG = "upsurge-noanswer-voicemail-ai";

/**
 * Outcomes that are terminal by definition (the contact leaves the flow).
 * Used as a safety net when the workspace taxonomy is missing a row: a `dnd` or
 * `not_interested` must NEVER keep getting dialed just because someone forgot to
 * seed a tag — that's a compliance hazard.
 */
const INTRINSIC_TERMINAL: ReadonlySet<CallOutcome> = new Set([
  "appointment",
  "not_interested",
  "dnd",
]);

export function reconcileTags(input: TagReconcileInput): TagReconcileResult {
  const { currentTags, taxonomy, outcome, enrollTag } = input;

  const allOutcomeTags = new Set(taxonomy.map((t) => t.tag));
  const match = taxonomy.find((t) => t.outcome === outcome);
  if (!match) {
    // Don't silently mislabel: a missing taxonomy row means the wrong tag (and,
    // without the intrinsic-terminal net below, the wrong terminal decision).
    console.warn(
      `[tags] no workspace taxonomy tag for outcome "${outcome}" — using fallback. Seed a workspace_outcome_tags row for this outcome.`
    );
  }
  const appliedTag = match?.tag ?? FALLBACK_NO_ANSWER_VOICEMAIL_TAG;
  const isTerminal = match?.is_terminal ?? INTRINSIC_TERMINAL.has(outcome);

  // Keep everything that isn't an AI outcome tag. Drop the enroll marker only
  // when the outcome is terminal (so terminal contacts leave the flow).
  const kept = currentTags.filter((t) => {
    if (allOutcomeTags.has(t)) return false;
    if (outcome === "no_answer_voicemail" && LEGACY_NO_ANSWER_VOICEMAIL_TAGS.has(t)) {
      return false;
    }
    if (isTerminal && t === enrollTag) return false;
    return true;
  });

  const next = Array.from(new Set([...kept, appliedTag]));
  return { tags: next, appliedTag, isTerminal };
}
