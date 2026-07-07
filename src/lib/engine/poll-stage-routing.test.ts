import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyPollStageRouting } from "@/lib/engine/pipeline-routing";
import type { AgentTaskConfig, Contact } from "@/types";
import type { CrmAdapter } from "@/lib/crm";

function makeContact(id: string, crmContactId: string): Contact {
  return {
    id,
    workspace_id: "ws-1",
    crm_contact_id: crmContactId,
    full_name: "Test Contact",
    email: null,
    phones: ["+15551234567"],
    tags: [],
    attempt_count: 0,
    last_called_on: null,
    next_eligible_on: null,
    is_terminal: false,
    terminal_outcome: null,
  };
}

function makeTaskConfig(overrides: Partial<AgentTaskConfig> = {}): AgentTaskConfig {
  return {
    agent_id: "agent-1",
    enabled: false,
    name_template: "",
    task_type: "Follow Up",
    assignee_crm_id: null,
    assignee_label: null,
    due_offset_minutes: 0,
    due_at_time: null,
    min_duration_seconds: 0,
    only_outcomes: null,
    post_call_webhook_enabled: false,
    post_call_webhook_url: null,
    post_call_webhook_only_outcomes: null,
    pipeline_automation_enabled: false,
    poll_stage_enabled: true,
    poll_pipeline_id: "pipe-1",
    poll_pipeline_stage_id: "stage-1",
    poll_pipeline_name: "Seller Pipeline",
    poll_stage_name: "Day 1",
    opportunity_custom_field_enabled: true,
    opportunity_custom_field_id: "cf_ai_agent",
    opportunity_custom_field_key: "ai_agent",
    opportunity_custom_field_label: "AI Agent",
    opportunity_custom_field_value: "Seller Outgoing AI Agent",
    opportunity_custom_field_value_label: "Seller Outgoing AI Agent",
    ...overrides,
  };
}

describe("applyPollStageRouting", () => {
  it("moves only provided contacts with custom fields when poll stage is enabled", async () => {
    const moves: Array<Record<string, unknown>> = [];
    const crm = {
      moveContactToStage: async (input: Record<string, unknown>) => {
        moves.push(input);
      },
    } as unknown as CrmAdapter;

    await applyPollStageRouting({
      crm,
      contacts: [
        makeContact("c1", "crm-1"),
        makeContact("c2", "crm-2"),
      ],
      taskConfig: makeTaskConfig(),
    });

    assert.equal(moves.length, 2);
    assert.equal(moves[0].contactId, "crm-1");
    assert.equal(moves[0].pipelineId, "pipe-1");
    assert.equal(moves[0].stageId, "stage-1");
    assert.deepEqual(moves[0].customFields, [
      {
        id: "cf_ai_agent",
        key: "ai_agent",
        field_value: "Seller Outgoing AI Agent",
      },
    ]);
  });

  it("no-ops when poll stage automation is disabled", async () => {
    let called = false;
    const crm = {
      moveContactToStage: async () => {
        called = true;
      },
    } as unknown as CrmAdapter;

    await applyPollStageRouting({
      crm,
      contacts: [makeContact("c1", "crm-1")],
      taskConfig: makeTaskConfig({ poll_stage_enabled: false }),
    });

    assert.equal(called, false);
  });

  it("no-ops when poll pipeline/stage is incomplete", async () => {
    let called = false;
    const crm = {
      moveContactToStage: async () => {
        called = true;
      },
    } as unknown as CrmAdapter;

    await applyPollStageRouting({
      crm,
      contacts: [makeContact("c1", "crm-1")],
      taskConfig: makeTaskConfig({ poll_pipeline_stage_id: null }),
    });

    assert.equal(called, false);
  });
});
