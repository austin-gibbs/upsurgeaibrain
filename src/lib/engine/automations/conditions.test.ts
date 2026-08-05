// =====================================================================
// Unit tests for the post-call automation matcher + template renderer.
// Both are pure (no I/O), so they cover the risky logic — condition matching,
// boolean coercion of Retell's stringly-typed fields, outcome gating, and the
// {{...}} placeholder rendering that reaches a lead's text.
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { triggerMatches } from "./conditions";
import { renderTemplate, renderPayload } from "./render";
import type { AutomationCondition, AutomationEvalContext, MatchType } from "./types";

function ctx(over: Partial<AutomationEvalContext> = {}): AutomationEvalContext {
  return {
    outcome: "follow_up" as AutomationEvalContext["outcome"],
    direction: "outbound",
    summary: "Caller wants the buyer guide.",
    transcript: "…please text me the buyer guide…",
    recordingUrl: null,
    customFields: {},
    contact: {
      first_name: "Paul",
      full_name: "Paul Avratin",
      email: "paul@example.com",
      phone: "+14045551234",
    },
    ...over,
  };
}

function trigger(
  conditions: AutomationCondition[],
  match_type: MatchType = "all",
  only_outcomes: string[] | null = null,
  direction_scope: "all" | "inbound" | "outbound" = "all"
) {
  return { conditions, match_type, only_outcomes, direction_scope };
}

describe("triggerMatches — boolean coercion", () => {
  it("is_true matches real boolean true", () => {
    assert.equal(
      triggerMatches(trigger([{ field: "link_requested", operator: "is_true" }]), ctx({ customFields: { link_requested: true } })),
      true
    );
  });

  it('is_true matches the strings "true"/"yes"/"1"', () => {
    for (const v of ["true", "yes", "Y", "1"]) {
      assert.equal(
        triggerMatches(trigger([{ field: "link_requested", operator: "is_true" }]), ctx({ customFields: { link_requested: v } })),
        true,
        `expected "${v}" to coerce truthy`
      );
    }
  });

  it("is_true is false when the field is missing or falsey", () => {
    assert.equal(triggerMatches(trigger([{ field: "link_requested", operator: "is_true" }]), ctx()), false);
    assert.equal(
      triggerMatches(trigger([{ field: "link_requested", operator: "is_true" }]), ctx({ customFields: { link_requested: "no" } })),
      false
    );
  });

  it("is_false matches a missing field", () => {
    assert.equal(triggerMatches(trigger([{ field: "link_requested", operator: "is_false" }]), ctx()), true);
  });
});

describe("triggerMatches — comparison operators", () => {
  it("eq is case/space-insensitive", () => {
    assert.equal(
      triggerMatches(trigger([{ field: "link_type", operator: "eq", value: "Buyer_Guide" }]), ctx({ customFields: { link_type: " buyer_guide " } })),
      true
    );
  });

  it("neq matches when different", () => {
    assert.equal(
      triggerMatches(trigger([{ field: "link_type", operator: "neq", value: "seller_guide" }]), ctx({ customFields: { link_type: "buyer_guide" } })),
      true
    );
  });

  it("contains does a substring match", () => {
    assert.equal(
      triggerMatches(trigger([{ field: "summary", operator: "contains", value: "buyer guide" }]), ctx()),
      true
    );
  });

  it("in accepts an array and a comma string", () => {
    assert.equal(
      triggerMatches(trigger([{ field: "link_type", operator: "in", value: ["buyer_guide", "seller_guide"] }]), ctx({ customFields: { link_type: "seller_guide" } })),
      true
    );
    assert.equal(
      triggerMatches(trigger([{ field: "link_type", operator: "in", value: "buyer_guide, seller_guide" }]), ctx({ customFields: { link_type: "buyer_guide" } })),
      true
    );
  });

  it("exists / not_exists treat empty string as absent", () => {
    assert.equal(triggerMatches(trigger([{ field: "link_type", operator: "exists" }]), ctx({ customFields: { link_type: "" } })), false);
    assert.equal(triggerMatches(trigger([{ field: "link_type", operator: "not_exists" }]), ctx({ customFields: {} })), true);
  });
});

describe("triggerMatches — combination + gating", () => {
  it("match_type all requires every condition", () => {
    const conds: AutomationCondition[] = [
      { field: "link_requested", operator: "is_true" },
      { field: "link_type", operator: "eq", value: "buyer_guide" },
    ];
    assert.equal(triggerMatches(trigger(conds, "all"), ctx({ customFields: { link_requested: true, link_type: "buyer_guide" } })), true);
    assert.equal(triggerMatches(trigger(conds, "all"), ctx({ customFields: { link_requested: true, link_type: "seller_guide" } })), false);
  });

  it("match_type any needs only one condition", () => {
    const conds: AutomationCondition[] = [
      { field: "link_requested", operator: "is_true" },
      { field: "link_type", operator: "eq", value: "buyer_guide" },
    ];
    assert.equal(triggerMatches(trigger(conds, "any"), ctx({ customFields: { link_type: "buyer_guide" } })), true);
  });

  it("empty conditions match (fires purely on the outcome gate)", () => {
    assert.equal(triggerMatches(trigger([], "all", ["follow_up"]), ctx()), true);
  });

  it("only_outcomes gate blocks non-matching outcomes", () => {
    assert.equal(triggerMatches(trigger([], "all", ["appointment"]), ctx({ outcome: "follow_up" as AutomationEvalContext["outcome"] })), false);
  });

  it("outcome pseudo-field is usable as a condition", () => {
    assert.equal(triggerMatches(trigger([{ field: "outcome", operator: "eq", value: "follow_up" }]), ctx()), true);
  });

  it("direction_scope inbound rejects outbound calls", () => {
    assert.equal(
      triggerMatches(trigger([], "all", null, "inbound"), ctx({ direction: "outbound" })),
      false
    );
  });

  it("direction_scope outbound rejects inbound calls", () => {
    assert.equal(
      triggerMatches(trigger([], "all", null, "outbound"), ctx({ direction: "inbound" })),
      false
    );
  });

  it("direction_scope all matches both directions", () => {
    assert.equal(triggerMatches(trigger([], "all", null, "all"), ctx({ direction: "inbound" })), true);
    assert.equal(triggerMatches(trigger([], "all", null, "all"), ctx({ direction: "outbound" })), true);
  });

  it("inbound only_outcomes aliases outbound appointment → appointment_booked", () => {
    assert.equal(
      triggerMatches(
        trigger([], "all", ["appointment", "follow_up", "interested_no_appointment"], "all"),
        ctx({ direction: "inbound", outcome: "appointment_booked" })
      ),
      true
    );
  });

  it("inbound only_outcomes aliases interested_no_appointment → interested", () => {
    assert.equal(
      triggerMatches(
        trigger([], "all", ["interested_no_appointment"], "all"),
        ctx({ direction: "inbound", outcome: "interested" })
      ),
      true
    );
  });

  it("outbound only_outcomes stays exact (no aliasing)", () => {
    assert.equal(
      triggerMatches(
        trigger([], "all", ["appointment"], "all"),
        ctx({ direction: "outbound", outcome: "appointment_booked" as AutomationEvalContext["outcome"] })
      ),
      false
    );
    assert.equal(
      triggerMatches(
        trigger([], "all", ["appointment"], "all"),
        ctx({ direction: "outbound", outcome: "appointment" as AutomationEvalContext["outcome"] })
      ),
      true
    );
  });
});

describe("renderTemplate", () => {
  const scope = {
    ctx: ctx({ customFields: { link_type: "buyer_guide" } }),
    link: { type: "buyer_guide", url: "https://ex.com/g.pdf", label: "Buyer's Guide" },
  };

  it("renders contact + link placeholders", () => {
    assert.equal(
      renderTemplate("Hi {{contact.first_name}}, here's your link: {{link.url}}", scope),
      "Hi Paul, here's your link: https://ex.com/g.pdf"
    );
  });

  it("renders bare + fields.* as custom_analysis_data", () => {
    assert.equal(renderTemplate("{{link_type}}/{{fields.link_type}}", scope), "buyer_guide/buyer_guide");
  });

  it("unknown placeholder renders empty (never leaks a raw token)", () => {
    assert.equal(renderTemplate("A{{nope}}B", scope), "AB");
  });

  it("renderPayload deep-renders string leaves only", () => {
    const out = renderPayload({ msg: "link {{link.url}}", n: 5, nested: { u: "{{link.url}}" } }, scope);
    assert.deepEqual(out, { msg: "link https://ex.com/g.pdf", n: 5, nested: { u: "https://ex.com/g.pdf" } });
  });
});
