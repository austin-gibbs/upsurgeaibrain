import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTaskConfig } from "@/types";
import { parseAssignees, shouldCreateTask } from "@/lib/engine/task-eligibility";

function baseTaskConfig(overrides: Partial<AgentTaskConfig> = {}): AgentTaskConfig {
  return {
    agent_id: "agent-1",
    enabled: true,
    name_template: "Review {contact_name}",
    task_type: "Follow Up",
    assignee_crm_id: "1,17,76",
    assignee_label: "Nil, Jori, Rex",
    due_offset_minutes: 0,
    due_at_time: null,
    min_duration_seconds: 0,
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
    ...overrides,
  };
}

describe("shouldCreateTask", () => {
  it("allows tasks for any outcome when only_outcomes is null", () => {
    assert.equal(shouldCreateTask(baseTaskConfig(), "follow_up", 45), true);
  });

  it("respects only_outcomes when no duration gate is configured", () => {
    const cfg = baseTaskConfig({ only_outcomes: ["appointment"] });
    assert.equal(shouldCreateTask(cfg, "appointment", 10), true);
    assert.equal(shouldCreateTask(cfg, "follow_up", 10), false);
  });

  it("skips tasks when duration is below min_duration_seconds", () => {
    const cfg = baseTaskConfig({ min_duration_seconds: 30 });
    assert.equal(shouldCreateTask(cfg, "follow_up", 29), false);
    assert.equal(shouldCreateTask(cfg, "follow_up", 30), true);
    assert.equal(shouldCreateTask(cfg, "follow_up", 45), true);
  });

  it("does not gate tasks when min_duration_seconds is 0", () => {
    const cfg = baseTaskConfig({ min_duration_seconds: 0 });
    assert.equal(shouldCreateTask(cfg, "follow_up", 5), true);
  });

  it("requires both duration and outcome rules when both are set", () => {
    const cfg = baseTaskConfig({
      min_duration_seconds: 30,
      only_outcomes: ["appointment"],
    });
    assert.equal(shouldCreateTask(cfg, "appointment", 30), true);
    assert.equal(shouldCreateTask(cfg, "appointment", 20), false);
    assert.equal(shouldCreateTask(cfg, "follow_up", 45), false);
  });
});

describe("parseAssignees", () => {
  it("splits comma-separated CRM user ids", () => {
    assert.deepEqual(parseAssignees("1,17,76"), ["1", "17", "76"]);
  });

  it("returns empty array for null or blank input", () => {
    assert.deepEqual(parseAssignees(null), []);
    assert.deepEqual(parseAssignees("  "), []);
  });
});
