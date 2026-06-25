import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultTaskConfig } from "@/components/agent-form/types";
import {
  prepareTaskConfigForSave,
  validateTaskConfigForSave,
} from "@/lib/task-config";

describe("prepareTaskConfigForSave", () => {
  it("auto-enables opportunity field when id and value are set", () => {
    const prepared = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      opportunity_custom_field_enabled: false,
      opportunity_custom_field_id: " cf_1 ",
      opportunity_custom_field_value: " Seller Outgoing AI Agent ",
      opportunity_custom_field_label: "AI Agent",
    });
    assert.equal(prepared.opportunity_custom_field_enabled, true);
    assert.equal(prepared.opportunity_custom_field_id, "cf_1");
    assert.equal(prepared.opportunity_custom_field_value, "Seller Outgoing AI Agent");
  });

  it("disables incomplete opportunity toggle instead of failing validation", () => {
    const prepared = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      opportunity_custom_field_enabled: true,
      opportunity_custom_field_id: "cf_1",
      opportunity_custom_field_value: null,
    });
    assert.equal(prepared.opportunity_custom_field_enabled, false);
  });

  it("disables incomplete poll stage toggle", () => {
    const prepared = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      poll_stage_enabled: true,
      poll_pipeline_id: "pipe_1",
      poll_pipeline_stage_id: null,
    });
    assert.equal(prepared.poll_stage_enabled, false);
  });
});

describe("validateTaskConfigForSave", () => {
  it("returns null for a complete opportunity field config", () => {
    assert.equal(
      validateTaskConfigForSave(
        prepareTaskConfigForSave({
          ...defaultTaskConfig(),
          opportunity_custom_field_enabled: true,
          opportunity_custom_field_id: "cf_1",
          opportunity_custom_field_value: "Seller Outgoing AI Agent",
        })
      ),
      null
    );
  });
});
