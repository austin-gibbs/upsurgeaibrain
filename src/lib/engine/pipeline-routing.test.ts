import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildOpportunityCustomFieldsPayload } from "@/lib/crm/highlevel";
import {
  buildCustomFieldsFromTaskConfig,
} from "@/lib/engine/pipeline-routing";
import type { AgentTaskConfig } from "@/types";

describe("buildOpportunityCustomFieldsPayload", () => {
  it("returns undefined when no custom fields are provided", () => {
    assert.equal(buildOpportunityCustomFieldsPayload(undefined), undefined);
    assert.equal(buildOpportunityCustomFieldsPayload([]), undefined);
  });

  it("maps id, key, and field_value for create/update bodies", () => {
    assert.deepEqual(
      buildOpportunityCustomFieldsPayload([
        { id: "cf_123", key: "ai_agent", field_value: "Seller Outgoing AI Agent" },
      ]),
      [{ id: "cf_123", key: "ai_agent", field_value: "Seller Outgoing AI Agent" }]
    );
  });
});

describe("buildCustomFieldsFromTaskConfig", () => {
  const base: AgentTaskConfig = {
    agent_id: "agent-1",
    enabled: false,
    name_template: "",
    task_type: "Follow Up",
    assignee_crm_id: null,
    assignee_label: null,
    due_offset_minutes: 0,
    due_at_time: null,
    only_outcomes: null,
    post_call_webhook_enabled: false,
    post_call_webhook_url: null,
    post_call_webhook_only_outcomes: null,
    pipeline_automation_enabled: false,
    poll_stage_enabled: false,
    poll_pipeline_id: null,
    poll_pipeline_stage_id: null,
    poll_pipeline_name: null,
    poll_stage_name: null,
    opportunity_custom_field_enabled: false,
    opportunity_custom_field_id: null,
    opportunity_custom_field_key: null,
    opportunity_custom_field_label: null,
    opportunity_custom_field_value: null,
    opportunity_custom_field_value_label: null,
  };

  it("returns undefined when custom field automation is disabled", () => {
    assert.equal(buildCustomFieldsFromTaskConfig(base), undefined);
  });

  it("returns the configured custom field payload when enabled", () => {
    assert.deepEqual(
      buildCustomFieldsFromTaskConfig({
        ...base,
        opportunity_custom_field_enabled: true,
        opportunity_custom_field_id: "cf_ai_agent",
        opportunity_custom_field_key: "ai_agent",
        opportunity_custom_field_value: "Seller Outgoing AI Agent",
      }),
      [
        {
          id: "cf_ai_agent",
          key: "ai_agent",
          field_value: "Seller Outgoing AI Agent",
        },
      ]
    );
  });

  it("requires both field id and value", () => {
    assert.equal(
      buildCustomFieldsFromTaskConfig({
        ...base,
        opportunity_custom_field_enabled: true,
        opportunity_custom_field_id: "cf_ai_agent",
        opportunity_custom_field_value: null,
      }),
      undefined
    );
  });
});
