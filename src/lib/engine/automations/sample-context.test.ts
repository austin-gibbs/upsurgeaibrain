// =====================================================================
// Unit tests for the "Test Push" sample context.
//
// The point of a test push is that the CRM can be mapped against it, so the
// sample MUST satisfy the trigger's own conditions (otherwise the operator maps
// a payload that never arrives) and must populate every field the trigger's
// templates reference. Both are pure, so they're covered here.
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRequest } from "./build-request";
import {
  buildSampleContext,
  SAMPLE_CONTACT,
  SAMPLE_RECORDING_URL,
  type SampleTrigger,
} from "./sample-context";
import type { AutomationCondition } from "./types";

function trigger(over: Partial<SampleTrigger> = {}): SampleTrigger {
  return {
    match_type: "all",
    conditions: [],
    only_outcomes: null,
    action_config: {},
    ...over,
  };
}

describe("buildSampleContext — satisfies the trigger's own conditions", () => {
  it("fills every operator so the sample matches", () => {
    const conditions: AutomationCondition[] = [
      { field: "link_requested", operator: "is_true" },
      { field: "already_sent", operator: "is_false" },
      { field: "link_type", operator: "eq", value: "seller_guide" },
      { field: "source", operator: "neq", value: "walk_in" },
      { field: "notes", operator: "contains", value: "valuation" },
      { field: "stage", operator: "in", value: ["hot", "warm"] },
      { field: "agent_note", operator: "exists" },
      { field: "opted_out", operator: "not_exists" },
    ];
    const { ctx, matches } = buildSampleContext(trigger({ conditions }));

    assert.equal(matches, true);
    assert.equal(ctx.customFields.link_requested, true);
    assert.equal(ctx.customFields.already_sent, false);
    assert.equal(ctx.customFields.link_type, "seller_guide");
    assert.equal(ctx.customFields.stage, "hot");
    assert.ok(!("opted_out" in ctx.customFields));
    assert.ok(String(ctx.customFields.notes).includes("valuation"));
  });

  it("matches an 'any' trigger and a summary/transcript condition", () => {
    const { ctx, matches } = buildSampleContext(
      trigger({
        match_type: "any",
        conditions: [
          { field: "summary", operator: "contains", value: "buyer guide" },
          { field: "link_requested", operator: "is_true" },
        ],
      })
    );
    assert.equal(matches, true);
    assert.ok(String(ctx.summary).includes("buyer guide"));
  });

  it("uses an allowed outcome when the trigger gates on only_outcomes", () => {
    const { ctx, matches } = buildSampleContext(
      trigger({ only_outcomes: ["follow_up", "appointment"] })
    );
    assert.equal(ctx.outcome, "follow_up");
    assert.equal(ctx.customFields.call_outcome, "follow_up");
    assert.equal(matches, true);
  });

  it("honours an outcome condition and ignores a non-outcome value", () => {
    assert.equal(
      buildSampleContext(trigger({ conditions: [{ field: "outcome", operator: "eq", value: "dnd" }] }))
        .ctx.outcome,
      "dnd"
    );
    assert.equal(
      buildSampleContext(
        trigger({ conditions: [{ field: "outcome", operator: "eq", value: "not_an_outcome" }] })
      ).ctx.outcome,
      "appointment"
    );
  });

  it("never picks an outcome the only_outcomes gate would reject", () => {
    const { ctx, matches } = buildSampleContext(
      trigger({
        only_outcomes: ["appointment"],
        conditions: [{ field: "outcome", operator: "eq", value: "dnd" }],
      })
    );
    assert.equal(ctx.outcome, "appointment");
    // Contradictory config can't match — the console warns instead of pretending.
    assert.equal(matches, false);
  });
});

describe("buildSampleContext — fields the CRM has to map", () => {
  it("always includes the default analysis fields every agent emits", () => {
    const { ctx } = buildSampleContext(trigger());
    assert.equal(ctx.customFields.call_outcome, "appointment");
    assert.equal(typeof ctx.customFields.appointment_time, "string");
  });

  it("populates fields referenced only by the templates", () => {
    const { ctx } = buildSampleContext(
      trigger({
        action_config: {
          message_template: "Hi {{contact.first_name}}, re {{fields.property_address}} — {{budget}}",
          payload_template: { note: "{{agent_notes}}", url: "{{link.url}}" },
        },
      })
    );
    assert.equal(ctx.customFields.property_address, "test_property_address");
    assert.equal(ctx.customFields.budget, "test_budget");
    assert.equal(ctx.customFields.agent_notes, "test_agent_notes");
    // Template roots are context, not analysis fields.
    assert.ok(!("contact" in ctx.customFields));
    assert.ok(!("link" in ctx.customFields));
  });

  it("uses a mapped link_type so link_url resolves", () => {
    const { ctx } = buildSampleContext(
      trigger({ action_config: { link_type_field: "link_type" } }),
      { linkTypes: ["home_valuation", "buyer_guide"] }
    );
    assert.equal(ctx.customFields.link_type, "home_valuation");
  });

  it("keeps a condition's link_type instead of overwriting it", () => {
    const { ctx } = buildSampleContext(
      trigger({
        conditions: [{ field: "link_type", operator: "eq", value: "seller_guide" }],
        action_config: { link_type_field: "link_type" },
      }),
      { linkTypes: ["buyer_guide"] }
    );
    assert.equal(ctx.customFields.link_type, "seller_guide");
  });

  it("does not resurrect a field a condition requires to be absent", () => {
    const { ctx } = buildSampleContext(
      trigger({
        conditions: [{ field: "opted_out", operator: "not_exists" }],
        action_config: { message_template: "{{opted_out}}" },
      })
    );
    assert.ok(!("opted_out" in ctx.customFields));
  });
});

describe("buildSampleContext + buildRequest — the delivered body", () => {
  it("renders the default payload with fake contact data and the resolved link", () => {
    const spec = trigger({
      conditions: [{ field: "link_requested", operator: "is_true" }],
      action_config: {
        url: "https://example.com/hook",
        link_type_field: "link_type",
        message_template: "Hi {{contact.first_name}}, here's the info: {{link.url}}",
      },
    });
    const { ctx } = buildSampleContext(spec, { linkTypes: ["buyer_guide"] });
    const { url, payload } = buildRequest(
      { name: "Send requested link", action_type: "highlevel_sms", action_config: spec.action_config },
      ctx,
      { type: "buyer_guide", url: "https://ex.com/g.pdf", label: "Buyer's Guide" }
    );

    assert.equal(url, "https://example.com/hook");
    assert.equal(payload.event, "post_call_automation");
    assert.equal(payload.link_url, "https://ex.com/g.pdf");
    assert.equal(payload.message, "Hi Test, here's the info: https://ex.com/g.pdf");
    assert.deepEqual(payload.contact, {
      name: SAMPLE_CONTACT.full_name,
      first_name: SAMPLE_CONTACT.first_name,
      email: SAMPLE_CONTACT.email,
      phone: SAMPLE_CONTACT.phone,
    });
    assert.equal(payload.recording_url, SAMPLE_RECORDING_URL);
  });

  it("leaves no unrendered placeholder in a custom payload template", () => {
    const action_config = {
      url: "https://example.com/hook",
      payload_template: {
        phone: "{{contact.phone}}",
        text: "{{fields.property_address}} — {{link.url}}",
      },
    };
    const { ctx } = buildSampleContext(trigger({ action_config }));
    const { payload } = buildRequest(
      { name: "Custom", action_type: "webhook", action_config },
      ctx,
      { type: null, url: null, label: null }
    );
    assert.equal(payload.phone, SAMPLE_CONTACT.phone);
    assert.ok(!JSON.stringify(payload).includes("{{"));
    assert.ok(String(payload.text).includes("test_property_address"));
    assert.equal(payload.recording_url, SAMPLE_RECORDING_URL);
  });
});
