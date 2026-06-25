import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSelectableOpportunityField,
  mapCustomFieldOptions,
  parseOpportunityCustomField,
} from "@/lib/crm/highlevel";

describe("parseOpportunityCustomField", () => {
  it("parses SINGLE_OPTIONS with string picklist options", () => {
    const field = parseOpportunityCustomField({
      id: "cf_1",
      name: "AI Agent",
      fieldKey: "opportunity.ai_agent",
      dataType: "SINGLE_OPTIONS",
      picklistOptions: ["Seller Outgoing AI Agent", "Buyer AI Agent"],
    });
    assert.ok(field);
    assert.equal(field!.name, "AI Agent");
    assert.deepEqual(field!.options, [
      { label: "Seller Outgoing AI Agent", value: "Seller Outgoing AI Agent" },
      { label: "Buyer AI Agent", value: "Buyer AI Agent" },
    ]);
  });

  it("parses RADIO fields with object options", () => {
    assert.equal(isSelectableOpportunityField({ dataType: "RADIO" }), true);
    const field = parseOpportunityCustomField({
      id: "cf_2",
      name: "AI Agent",
      dataType: "RADIO",
      options: [{ key: "opt_1", label: "Seller Outgoing AI Agent" }],
    });
    assert.ok(field);
    assert.deepEqual(field!.options, [
      { label: "Seller Outgoing AI Agent", value: "Seller Outgoing AI Agent" },
    ]);
  });

  it("returns null for plain text fields without options", () => {
    assert.equal(
      parseOpportunityCustomField({
        id: "cf_3",
        name: "Notes",
        dataType: "TEXT",
        picklistOptions: [],
      }),
      null
    );
  });
});

describe("mapCustomFieldOptions", () => {
  it("uses label as stored value for object options", () => {
    assert.deepEqual(
      mapCustomFieldOptions([{ key: "k1", label: "Seller Outgoing AI Agent" }]),
      [{ label: "Seller Outgoing AI Agent", value: "Seller Outgoing AI Agent" }]
    );
  });
});
