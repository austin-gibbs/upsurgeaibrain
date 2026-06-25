import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSelectableOpportunityField,
  mapCustomFieldOptions,
  parseOpportunityCustomField,
} from "@/lib/crm/highlevel";

describe("mapCustomFieldOptions", () => {
  it("maps V2 option objects with label and key", () => {
    assert.deepEqual(
      mapCustomFieldOptions([
        { key: "opt_1", label: "Seller Outgoing AI Agent" },
        { key: "opt_2", label: "Buyer Incoming AI Agent" },
      ]),
      [
        { label: "Seller Outgoing AI Agent", value: "Seller Outgoing AI Agent" },
        { label: "Buyer Incoming AI Agent", value: "Buyer Incoming AI Agent" },
      ]
    );
  });

  it("maps legacy string picklist options", () => {
    assert.deepEqual(
      mapCustomFieldOptions(["Day 1", "Day 2"]),
      [
        { label: "Day 1", value: "Day 1" },
        { label: "Day 2", value: "Day 2" },
      ]
    );
  });

  it("maps picklistImageOptions name fields", () => {
    assert.deepEqual(mapCustomFieldOptions([{ name: "AI Agent A" }]), [
      { label: "AI Agent A", value: "AI Agent A" },
    ]);
  });
});

describe("parseOpportunityCustomField", () => {
  it("reads options from nested customField wrapper", () => {
    const parsed = parseOpportunityCustomField({
      customField: {
        id: "cf_1",
        name: "AI Agent",
        dataType: "SINGLE_OPTIONS",
        fieldKey: "opportunity.ai_agent",
        options: [{ key: "a", label: "Seller Outgoing AI Agent" }],
      },
    } as Record<string, unknown>);
    assert.ok(parsed);
    assert.equal(parsed!.options.length, 1);
    assert.equal(parsed!.options[0]?.label, "Seller Outgoing AI Agent");
  });

  it("includes dropdown fields even when list response omits options", () => {
    const parsed = parseOpportunityCustomField({
      id: "cf_2",
      name: "AI Agent",
      dataType: "SINGLE_OPTIONS",
      picklistOptions: [],
    });
    assert.ok(parsed);
    assert.equal(parsed!.options.length, 0);
    assert.equal(isSelectableOpportunityField({ dataType: "SINGLE_OPTIONS" }), true);
  });
});
