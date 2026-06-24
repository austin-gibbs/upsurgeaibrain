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

export function reconcileTags(input: TagReconcileInput): TagReconcileResult {
  const { currentTags, taxonomy, outcome, enrollTag } = input;

  const allOutcomeTags = new Set(taxonomy.map((t) => t.tag));
  const match = taxonomy.find((t) => t.outcome === outcome);
  const appliedTag = match?.tag ?? "upsurge-noanswer-voicemail-ai";
  const isTerminal = match?.is_terminal ?? false;

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
