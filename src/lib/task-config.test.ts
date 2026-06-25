import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultTaskConfig } from "@/components/agent-form/types";
import { mergePipelinesForRouting } from "@/lib/pipeline-options";
import {
  prepareStageMapForSave,
  prepareTaskConfigForSave,
  validateStageMapForSave,
  validateTaskConfigForSave,
} from "@/lib/task-config";

describe("mergePipelinesForRouting", () => {
  it("includes saved poll and routing rule stages not present in the API list", () => {
    const merged = mergePipelinesForRouting(
      [],
      {
        ...defaultTaskConfig(),
        poll_pipeline_id: "pipe_1",
        poll_pipeline_name: "AI Assistant",
        poll_pipeline_stage_id: "stage_poll",
        poll_stage_name: "Call Queue",
      },
      [
        {
          outcome: "no_answer_voicemail",
          call_attempt: 1,
          pipeline_id: "pipe_1",
          pipeline_stage_id: "stage_day1",
          pipeline_name: "AI Assistant",
          stage_name: "Day 1",
        },
      ]
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.id, "pipe_1");
    assert.deepEqual(
      merged[0]?.stages.map((s) => s.id).sort(),
      ["stage_day1", "stage_poll"]
    );
  });
});

describe("prepareTaskConfigForSave", () => {
  it("auto-enables opportunity field when id and value are set", () => {
    const prepared = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      opportunity_custom_field_enabled: false,
      opportunity_custom_field_id: " cf_1 ",
      opportunity_custom_field_value: " Seller Outgoing AI Agent ",
    });
    assert.equal(prepared.opportunity_custom_field_enabled, true);
    assert.equal(prepared.opportunity_custom_field_id, "cf_1");
  });

  it("keeps poll stage enabled when pipeline and stage are selected", () => {
    const prepared = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      poll_stage_enabled: true,
      poll_pipeline_id: "pipe_1",
      poll_pipeline_stage_id: "stage_1",
    });
    assert.equal(prepared.poll_stage_enabled, true);
  });
});

describe("prepareStageMapForSave", () => {
  it("drops incomplete routing rules", () => {
    const prepared = prepareStageMapForSave([
      {
        outcome: "appointment",
        call_attempt: null,
        pipeline_id: "pipe_1",
        pipeline_stage_id: "stage_1",
        pipeline_name: null,
        stage_name: null,
      },
      {
        outcome: "follow_up",
        call_attempt: null,
        pipeline_id: "pipe_1",
        pipeline_stage_id: "",
        pipeline_name: null,
        stage_name: null,
      },
    ]);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0]?.outcome, "appointment");
  });
});

describe("validateStageMapForSave", () => {
  it("rejects partially filled routing rules", () => {
    assert.match(
      validateStageMapForSave(
        [
          {
            outcome: "appointment",
            call_attempt: null,
            pipeline_id: "pipe_1",
            pipeline_stage_id: "",
            pipeline_name: null,
            stage_name: null,
          },
        ],
        true
      ) ?? "",
      /pipeline and stage/i
    );
  });

  it("returns null when automation is disabled", () => {
    assert.equal(
      validateStageMapForSave(
        [
          {
            outcome: "appointment",
            call_attempt: null,
            pipeline_id: "pipe_1",
            pipeline_stage_id: "",
            pipeline_name: null,
            stage_name: null,
          },
        ],
        false
      ),
      null
    );
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
