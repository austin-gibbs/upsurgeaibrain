// =====================================================================
// Orphan enroll-tag detection.
//
// A contact tagged in the CRM with a tag that no outbound agent polls is
// invisible to the engine: it never gets scanned, never becomes eligible, and
// never reaches the call queue. Nothing else in the pipeline can surface that
// — the poller only sees what its own tag returns — so it fails silently and
// looks like "the poll caught a contact but it never got called".
//
// A near-miss against a configured tag (upsurge.buyers.ai vs
// upsurge.realestatebuyers.ai) is almost always a typo on the CRM side and is
// worth alerting on. An orphan with no close match is usually a legacy or
// client-owned segmentation tag, so it is reported but not alerted.
// =====================================================================
import { normalizeEnrollTag } from "@/lib/agents/enroll-tag";

/** Core-similarity at or above this is treated as a likely typo of a real tag. */
export const NEAR_MISS_SIMILARITY = 0.7;
/** Score given when one tag's core contains the other's (upsurge.buyers.ai). */
export const CONTAINMENT_SCORE = 0.9;
/**
 * Shortest core that may match by containment. Without a floor, a two-letter
 * core would "contain" its way into every tag in the workspace.
 */
export const MIN_CONTAINMENT_CORE = 4;

export interface OrphanEnrollTag {
  /** The tag as it appears on contacts. */
  tag: string;
  /** How many contacts in the workspace carry it. */
  contactCount: number;
  /** Closest configured enroll tag, when one is similar enough to matter. */
  nearestEnrollTag: string | null;
  /** 0–1 similarity between the two tags' distinctive cores. */
  similarity: number;
  /** True when this looks like a misspelling of a configured tag. */
  isNearMiss: boolean;
}

export interface FindOrphanEnrollTagsInput {
  /** Tag arrays for every contact in the workspace. */
  contactTagSets: (string[] | null | undefined)[];
  /** Effective enroll tags of the workspace's outbound agents. */
  agentEnrollTags: string[];
  /** Workspace outcome taxonomy tags — written by us, never enrollment. */
  outcomeTags?: string[];
}

/** Levenshtein distance, iterative with a single rolling row. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 1 for identical strings, 0 for nothing in common. */
export function tagSimilarity(a: string, b: string): number {
  const x = normalizeEnrollTag(a);
  const y = normalizeEnrollTag(b);
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - editDistance(x, y) / longest;
}

/**
 * Tags we write ourselves during a call cycle. These are never enrollment
 * tags, so they must not be reported as orphans.
 */
function isEngineWrittenTag(tag: string): boolean {
  const t = normalizeEnrollTag(tag);
  // Per-day "called" markers, e.g. upsurgecalled20260804.
  if (/^upsurgecalled\d{8}$/.test(t)) return true;
  // Outcome tags follow the upsurge-<outcome>-ai convention.
  if (/^upsurge-.+-ai$/.test(t)) return true;
  return false;
}

/**
 * Candidate enrollment tags share a prefix with the tags this workspace's
 * agents already poll (e.g. `upsurge.`), which keeps a client's own CRM
 * taxonomy ("cold lead", "follow up") out of the results.
 */
export function enrollTagPrefixes(agentEnrollTags: string[]): string[] {
  const prefixes = new Set<string>();
  for (const raw of agentEnrollTags) {
    const tag = normalizeEnrollTag(raw);
    const separator = tag.search(/[.\-_]/);
    if (separator > 0) prefixes.add(tag.slice(0, separator + 1));
  }
  return [...prefixes];
}

/**
 * Strip the boilerplate every tag in the workspace shares — the vendor prefix
 * and the trailing `.ai` marker — leaving the part that actually identifies the
 * agent. Comparing whole tags would score `upsurge.nurture.ai` against
 * `upsurge.probate.ai` as a typo purely on shared scaffolding.
 */
export function enrollTagCore(tag: string, prefixes: string[]): string {
  let core = normalizeEnrollTag(tag);
  // Longest prefix first, so `upsurge.re.` wins over `upsurge.`.
  for (const prefix of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (core.startsWith(prefix)) {
      core = core.slice(prefix.length);
      break;
    }
  }
  return core.replace(/[._-]ai$/, "");
}

/**
 * How likely `core` is a misspelling of `candidateCore`. Containment scores
 * high because a hand-typed tag usually drops or adds a qualifier
 * (`buyers` vs `realestatebuyers`) rather than misspelling letters.
 */
export function scoreEnrollTagAffinity(core: string, candidateCore: string): number {
  if (!core.length || !candidateCore.length) return 0;
  const [shorter, longer] =
    core.length <= candidateCore.length ? [core, candidateCore] : [candidateCore, core];
  if (shorter.length >= MIN_CONTAINMENT_CORE && longer.includes(shorter)) {
    return CONTAINMENT_SCORE;
  }
  return tagSimilarity(core, candidateCore);
}

export function findOrphanEnrollTags(
  input: FindOrphanEnrollTagsInput
): OrphanEnrollTag[] {
  const polled = new Set(input.agentEnrollTags.map(normalizeEnrollTag));
  const outcome = new Set((input.outcomeTags ?? []).map(normalizeEnrollTag));
  const prefixes = enrollTagPrefixes(input.agentEnrollTags);
  if (prefixes.length === 0) return [];

  // Count contacts per candidate tag, keeping the first spelling we saw so the
  // operator can search for it verbatim in the CRM.
  const counts = new Map<string, { tag: string; count: number }>();
  for (const tags of input.contactTagSets) {
    // One contact must only count once per tag, even if the CRM duplicated it.
    const seen = new Set<string>();
    for (const raw of tags ?? []) {
      const tag = normalizeEnrollTag(raw);
      if (seen.has(tag)) continue;
      seen.add(tag);

      if (polled.has(tag) || outcome.has(tag)) continue;
      if (isEngineWrittenTag(tag)) continue;
      if (!prefixes.some((p) => tag.startsWith(p))) continue;

      const entry = counts.get(tag);
      if (entry) entry.count += 1;
      else counts.set(tag, { tag: raw.trim(), count: 1 });
    }
  }

  const orphans: OrphanEnrollTag[] = [];
  for (const { tag, count } of counts.values()) {
    const core = enrollTagCore(tag, prefixes);
    let nearestEnrollTag: string | null = null;
    let similarity = 0;
    for (const candidate of polled) {
      const score = scoreEnrollTagAffinity(core, enrollTagCore(candidate, prefixes));
      if (score > similarity) {
        similarity = score;
        nearestEnrollTag = candidate;
      }
    }
    orphans.push({
      tag,
      contactCount: count,
      nearestEnrollTag,
      similarity,
      isNearMiss: similarity >= NEAR_MISS_SIMILARITY,
    });
  }

  // Near misses first (most actionable), then by blast radius.
  return orphans.sort((a, b) => {
    if (a.isNearMiss !== b.isNearMiss) return a.isNearMiss ? -1 : 1;
    if (b.contactCount !== a.contactCount) return b.contactCount - a.contactCount;
    return a.tag.localeCompare(b.tag);
  });
}
