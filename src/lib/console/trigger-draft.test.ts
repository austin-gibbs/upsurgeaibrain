// =====================================================================
// Unit tests for the /admin/automations trigger form model.
//
// The risk these cover: an admin opens a saved automation, changes one thing,
// and saves. If the row -> form -> payload round trip drops or mangles a field,
// the save silently rewrites a live automation. They also pin the client-side
// validation that mirrors automationTriggerCreateSchema, and the `.strict()`
// action_config contract (only keys the action actually uses may be sent).
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  draftFromPayloadJson,
  draftFromTrigger,
  draftToJson,
  draftToPayload,
  emptyDraft,
  summarizeConditions,
  type TriggerRow,
} from "./trigger-draft";

function row(over: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: "trigger-1",
    workspace_id: "ws-1",
    agent_id: null,
    name: "Send requested link",
    description: "Caller asked for a link — text it via HighLevel.",
    enabled: true,
    match_type: "all",
    action_type: "highlevel_sms",
    conditions: [{ field: "link_requested", operator: "is_true" }],
    action_config: {
      url: "https://services.leadconnectorhq.com/hooks/abc",
      link_type_field: "link_type",
      message_template: "Hi {{contact.first_name}}: {{link.url}}",
    },
    dedupe_window_hours: 24,
    max_attempts: 5,
    only_outcomes: null,
    ...over,
  };
}

function payloadOf(r: TriggerRow) {
  const built = draftToPayload(draftFromTrigger(r));
  if (!built.ok) throw new Error(`expected a valid payload, got: ${built.error}`);
  return built.payload;
}

describe("draftFromTrigger -> draftToPayload round trip", () => {
  it("preserves a stored trigger unchanged when nothing is edited", () => {
    const original = row();
    const payload = payloadOf(original);

    assert.equal(payload.name, original.name);
    assert.equal(payload.description, original.description);
    assert.equal(payload.enabled, true);
    assert.equal(payload.match_type, "all");
    assert.equal(payload.action_type, "highlevel_sms");
    assert.deepEqual(payload.conditions, [{ field: "link_requested", operator: "is_true" }]);
    assert.deepEqual(payload.action_config, original.action_config);
    assert.equal(payload.dedupe_window_hours, 24);
    assert.equal(payload.max_attempts, 5);
    assert.equal(payload.only_outcomes, null);
  });

  it("keeps headers and a payload template through the JSON textareas", () => {
    const payload = payloadOf(
      row({
        action_type: "webhook",
        action_config: {
          url: "https://example.com/hook",
          method: "PUT",
          headers: { Authorization: "Bearer token" },
          payload_template: { phone: "{{contact.phone}}", text: "{{link.url}}" },
        },
      })
    );

    assert.deepEqual(payload.action_config, {
      url: "https://example.com/hook",
      method: "PUT",
      headers: { Authorization: "Bearer token" },
      payload_template: { phone: "{{contact.phone}}", text: "{{link.url}}" },
    });
  });

  it("round trips a typed condition value and an outcome gate", () => {
    const payload = payloadOf(
      row({
        match_type: "any",
        conditions: [
          { field: "link_type", operator: "in", value: ["buyer_guide", "seller_guide"] },
          { field: "summary", operator: "contains", value: "guide" },
        ],
        only_outcomes: ["appointment", "follow_up"],
      })
    );

    assert.equal(payload.match_type, "any");
    assert.deepEqual(payload.conditions, [
      { field: "link_type", operator: "in", value: ["buyer_guide", "seller_guide"] },
      { field: "summary", operator: "contains", value: "guide" },
    ]);
    assert.deepEqual(payload.only_outcomes, ["appointment", "follow_up"]);
  });

  it("reads a pinned link type as the static mode rather than a call field", () => {
    const draft = draftFromTrigger(
      row({ action_config: { url: "https://e.co/h", static_link_type: "buyer_guide" } })
    );
    assert.equal(draft.linkMode, "static");
    assert.equal(draft.staticLinkType, "buyer_guide");
  });

  it("treats a trigger with no link config as having no link", () => {
    const draft = draftFromTrigger(row({ action_config: { url: "https://e.co/h" } }));
    assert.equal(draft.linkMode, "none");
  });
});

describe("draftToPayload — action_config stays strict", () => {
  it("omits keys the chosen action does not use", () => {
    const draft = {
      ...draftFromTrigger(row()),
      linkMode: "none" as const,
      messageTemplate: "   ",
      headersJson: "",
      payloadJson: "",
    };
    const built = draftToPayload(draft);
    assert.equal(built.ok, true);
    if (!built.ok) return;

    assert.deepEqual(Object.keys(built.payload.action_config), ["url"]);
  });

  it("drops the URL entirely for internal_notify", () => {
    const draft = {
      ...draftFromTrigger(row()),
      actionType: "internal_notify" as const,
      url: "",
      linkMode: "none" as const,
      messageTemplate: "Heads up: {{contact.full_name}} asked for a link.",
    };
    const built = draftToPayload(draft);
    assert.equal(built.ok, true);
    if (!built.ok) return;

    assert.equal("url" in built.payload.action_config, false);
    assert.equal(
      built.payload.action_config.message_template,
      "Heads up: {{contact.full_name}} asked for a link."
    );
  });

  it("does not send the default POST method", () => {
    const built = draftToPayload(draftFromTrigger(row({ action_config: { url: "https://e.co/h" } })));
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal("method" in built.payload.action_config, false);
  });
});

describe("draftToPayload — validation mirrors the API schema", () => {
  it("requires a name", () => {
    const built = draftToPayload({ ...emptyDraft(), name: "  " });
    assert.equal(built.ok, false);
  });

  it("requires a delivery URL for outbound actions", () => {
    const built = draftToPayload({ ...emptyDraft(), name: "Test", url: "" });
    assert.equal(built.ok, false);
    if (built.ok) return;
    assert.match(built.error, /URL is required/i);
  });

  it("rejects a malformed URL before the request is made", () => {
    const built = draftToPayload({ ...emptyDraft(), name: "Test", url: "not-a-url" });
    assert.equal(built.ok, false);
  });

  it("rejects a condition missing its comparison value", () => {
    const built = draftToPayload({
      ...emptyDraft(),
      name: "Test",
      url: "https://e.co/h",
      conditions: [{ field: "link_type", operator: "eq", value: "" }],
    });
    assert.equal(built.ok, false);
    if (built.ok) return;
    assert.match(built.error, /Condition 1/);
  });

  it("rejects an out-of-range dedupe window", () => {
    const built = draftToPayload({
      ...emptyDraft(),
      name: "Test",
      url: "https://e.co/h",
      dedupeWindowHours: "1000",
    });
    assert.equal(built.ok, false);
  });

  it("reports invalid header JSON instead of silently dropping it", () => {
    const built = draftToPayload({
      ...emptyDraft(),
      name: "Test",
      url: "https://e.co/h",
      headersJson: "{ not json",
    });
    assert.equal(built.ok, false);
    if (built.ok) return;
    assert.match(built.error, /Custom headers/);
  });

  it("splits a comma-separated `is one of` value into an array", () => {
    const built = draftToPayload({
      ...emptyDraft(),
      name: "Test",
      url: "https://e.co/h",
      conditions: [{ field: "link_type", operator: "in", value: " buyer_guide , seller_guide " }],
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.deepEqual(built.payload.conditions[0].value, ["buyer_guide", "seller_guide"]);
  });
});

describe("JSON escape hatch", () => {
  it("survives a form -> JSON -> form round trip", () => {
    const before = draftFromTrigger(row({ only_outcomes: ["appointment"] }));
    const loaded = draftFromPayloadJson(draftToJson(before), before.agentId);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.deepEqual(loaded.draft, before);
  });

  it("serializes an incomplete draft so the JSON view still opens", () => {
    assert.doesNotThrow(() => draftToJson(emptyDraft()));
  });

  it("reports unparseable JSON rather than throwing", () => {
    const loaded = draftFromPayloadJson("{ nope", "");
    assert.equal(loaded.ok, false);
  });
});

describe("summarizeConditions", () => {
  it("describes an unconditional trigger", () => {
    assert.equal(summarizeConditions(row({ conditions: [] })), "Every analyzed call");
  });

  it("joins with the trigger's match type", () => {
    const text = summarizeConditions(
      row({
        match_type: "any",
        conditions: [
          { field: "link_requested", operator: "is_true" },
          { field: "link_type", operator: "eq", value: "buyer_guide" },
        ],
      })
    );
    assert.equal(text, "link_requested is true or link_type equals buyer_guide");
  });
});
