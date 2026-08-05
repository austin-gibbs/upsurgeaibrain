import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  enrollTagCore,
  enrollTagPrefixes,
  findOrphanEnrollTags,
  scoreEnrollTagAffinity,
  tagSimilarity,
} from "./orphan-enroll-tags";

const URE_AGENT_TAGS = [
  "upsurge.realestatebuyers.ai",
  "upsurge.realestatelistings.ai",
  "upsurge.realestatecheckinmix.ai",
  "upsurge.homevaluationaiagent.ai",
  "upsurge.listingreviews.ai",
];

const URE_OUTCOME_TAGS = [
  "upsurge-appointment-ai",
  "upsurge-notinterested-ai",
  "upsurge-dnd-ai",
  "upsurge-interestednoappointment-ai",
  "upsurge-followup-ai",
  "upsurge-noanswer-voicemail-ai",
];

describe("tagSimilarity", () => {
  it("scores identical tags as 1", () => {
    assert.equal(tagSimilarity("upsurge.buyers.ai", "upsurge.buyers.ai"), 1);
  });

  it("ignores case and surrounding whitespace", () => {
    assert.equal(tagSimilarity(" Upsurge.Buyers.AI ", "upsurge.buyers.ai"), 1);
  });

  it("scores a near-miss above an unrelated tag", () => {
    const nearMiss = tagSimilarity("upsurge.buyers.ai", "upsurge.realestatebuyers.ai");
    const unrelated = tagSimilarity("upsurge.buyers.ai", "upsurge.listingreviews.ai");
    assert.ok(nearMiss > unrelated, `${nearMiss} should exceed ${unrelated}`);
  });
});

describe("enrollTagCore", () => {
  it("strips the shared vendor prefix and the trailing .ai marker", () => {
    assert.equal(enrollTagCore("upsurge.realestatebuyers.ai", ["upsurge."]), "realestatebuyers");
    assert.equal(enrollTagCore("upsurge.buyers.ai", ["upsurge."]), "buyers");
  });

  it("prefers the longest matching prefix", () => {
    assert.equal(enrollTagCore("upsurge.re.buyers.ai", ["upsurge.", "upsurge.re."]), "buyers");
  });

  it("leaves a tag without the prefix alone", () => {
    assert.equal(enrollTagCore("remax-buyer", ["upsurge."]), "remax-buyer");
  });
});

describe("scoreEnrollTagAffinity", () => {
  it("treats a dropped qualifier as a near-miss", () => {
    assert.ok(scoreEnrollTagAffinity("buyers", "realestatebuyers") >= 0.7);
    assert.ok(scoreEnrollTagAffinity("probates", "probate") >= 0.7);
  });

  it("does not let shared scaffolding make unrelated cores look similar", () => {
    // Both are `upsurge.<word>.ai`, so only the cores may be compared.
    assert.ok(scoreEnrollTagAffinity("nurture", "probate") < 0.7);
    assert.ok(scoreEnrollTagAffinity("general", "probate") < 0.7);
  });

  it("ignores containment for cores too short to be meaningful", () => {
    assert.ok(scoreEnrollTagAffinity("ppl", "circleprospecting") < 0.7);
  });
});

describe("enrollTagPrefixes", () => {
  it("derives the prefix shared by the workspace's enroll tags", () => {
    assert.deepEqual(enrollTagPrefixes(URE_AGENT_TAGS), ["upsurge."]);
  });

  it("handles hyphen and underscore conventions", () => {
    assert.deepEqual(enrollTagPrefixes(["remax-buyer"]), ["remax-"]);
    assert.deepEqual(enrollTagPrefixes(["acme_sellers"]), ["acme_"]);
  });

  it("returns nothing for a single-token tag, so no orphans are guessed", () => {
    assert.deepEqual(enrollTagPrefixes(["buyercallqueue"]), []);
    assert.deepEqual(
      findOrphanEnrollTags({
        contactTagSets: [["anything", "at", "all"]],
        agentEnrollTags: ["buyercallqueue"],
      }),
      []
    );
  });
});

describe("findOrphanEnrollTags", () => {
  it("flags the tag no agent polls as a near-miss of the intended tag", () => {
    const orphans = findOrphanEnrollTags({
      contactTagSets: [
        ["cold lead", "follow up", "upsurge.buyers.ai", "upsurgecalled20260804"],
      ],
      agentEnrollTags: URE_AGENT_TAGS,
      outcomeTags: URE_OUTCOME_TAGS,
    });

    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].tag, "upsurge.buyers.ai");
    assert.equal(orphans[0].contactCount, 1);
    assert.equal(orphans[0].nearestEnrollTag, "upsurge.realestatebuyers.ai");
    assert.equal(orphans[0].isNearMiss, true);
  });

  it("ignores tags an agent already polls", () => {
    const orphans = findOrphanEnrollTags({
      contactTagSets: [["upsurge.realestatebuyers.ai"]],
      agentEnrollTags: URE_AGENT_TAGS,
      outcomeTags: URE_OUTCOME_TAGS,
    });
    assert.deepEqual(orphans, []);
  });

  it("matches polled tags case-insensitively", () => {
    const orphans = findOrphanEnrollTags({
      contactTagSets: [["Upsurge.RealEstateBuyers.AI"]],
      agentEnrollTags: URE_AGENT_TAGS,
    });
    assert.deepEqual(orphans, []);
  });

  it("ignores outcome tags and per-day called markers we write ourselves", () => {
    const orphans = findOrphanEnrollTags({
      contactTagSets: [
        [
          "upsurge-noanswer-voicemail-ai",
          "upsurge-appointment-ai",
          "upsurgecalled20260728",
          "upsurgecalled20260804",
        ],
      ],
      agentEnrollTags: URE_AGENT_TAGS,
      outcomeTags: URE_OUTCOME_TAGS,
    });
    assert.deepEqual(orphans, []);
  });

  it("ignores a client's own CRM taxonomy outside the enroll-tag prefix", () => {
    const orphans = findOrphanEnrollTags({
      contactTagSets: [
        ["cold lead", "booked appointment", "live transfer", "property valuation"],
      ],
      agentEnrollTags: URE_AGENT_TAGS,
      outcomeTags: URE_OUTCOME_TAGS,
    });
    assert.deepEqual(orphans, []);
  });

  it("reports legacy dot-style outcome tags without calling them near-misses", () => {
    // Nil Patel Realty carries these from before the taxonomy moved to
    // upsurge-<outcome>-ai. They are dead tags worth surfacing, but they are
    // not typos of an agent's enroll tag, so they must not trigger an alert.
    const orphans = findOrphanEnrollTags({
      contactTagSets: [
        ["upsurge.nurture.ai"],
        ["upsurge.nurture.ai"],
        ["upsurge.general.ai"],
      ],
      agentEnrollTags: [
        "upsurge.circleprospecting.ai",
        "upsurge.ppl.ai",
        "upsurge.probate.ai",
      ],
    });

    assert.equal(orphans.length, 2);
    assert.equal(orphans.every((o) => o.isNearMiss), false);
    assert.equal(orphans[0].tag, "upsurge.nurture.ai");
    assert.equal(orphans[0].contactCount, 2);
  });

  it("counts each contact once per tag and ranks near-misses first", () => {
    const orphans = findOrphanEnrollTags({
      contactTagSets: [
        ["upsurge.nurture.ai"],
        ["upsurge.nurture.ai"],
        ["upsurge.nurture.ai"],
        // Duplicated by the CRM — still one contact.
        ["upsurge.probates.ai", "upsurge.probates.ai"],
      ],
      agentEnrollTags: ["upsurge.probate.ai"],
    });

    assert.equal(orphans[0].tag, "upsurge.probates.ai");
    assert.equal(orphans[0].contactCount, 1);
    assert.equal(orphans[0].isNearMiss, true);
    assert.equal(orphans[1].tag, "upsurge.nurture.ai");
    assert.equal(orphans[1].contactCount, 3);
  });

  it("returns nothing when the workspace has no outbound agents", () => {
    assert.deepEqual(
      findOrphanEnrollTags({
        contactTagSets: [["upsurge.buyers.ai"]],
        agentEnrollTags: [],
      }),
      []
    );
  });
});
