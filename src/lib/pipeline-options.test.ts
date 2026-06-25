import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultTaskConfig } from "@/components/agent-form/types";
import {
  ensurePipelineOption,
  ensureStageOption,
  mergePipelinesForRouting,
} from "@/lib/pipeline-options";
import {
  prepareTaskConfigForSave,
  resolveTaskConfigAfterSave,
  taskConfigFromRow,
} from "@/lib/task-config";

/** Diamond Group Seller Outgoing agent poll-stage values (prod). */
const DIAMOND_POLL = {
  poll_stage_enabled: true,
  poll_pipeline_id: "EWaD1OeTy4KPGLcIkQJE",
  poll_pipeline_name: "#AI Assistant 🤖",
  poll_pipeline_stage_id: "ed76470d-e514-4208-8a37-932f6465ced1",
  poll_stage_name: "Call Queue ☎️",
};

describe("mergePipelinesForRouting", () => {
  it("merges API pipelines with poll config and routing rules", () => {
    const merged = mergePipelinesForRouting(
      [{ id: "pipe_api", name: "API Pipeline", stages: [{ id: "s1", name: "S1" }] }],
      {
        ...defaultTaskConfig(),
        poll_pipeline_id: "pipe_saved",
        poll_pipeline_name: "Saved Pipeline",
        poll_pipeline_stage_id: "stage_saved",
        poll_stage_name: "Saved Stage",
      },
      []
    );
    assert.equal(merged.length, 2);
    const saved = merged.find((p) => p.id === "pipe_saved");
    assert.ok(saved);
    assert.equal(saved?.stages[0]?.id, "stage_saved");
  });

  it("keeps Diamond Group poll stage selectable when HighLevel returns no pipelines", () => {
    const merged = mergePipelinesForRouting(
      [],
      { ...defaultTaskConfig(), ...DIAMOND_POLL },
      []
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.id, DIAMOND_POLL.poll_pipeline_id);
    assert.equal(merged[0]?.stages[0]?.id, DIAMOND_POLL.poll_pipeline_stage_id);
  });
});

describe("ensurePipelineOption / ensureStageOption", () => {
  it("injects saved poll pipeline and stage into empty option lists", () => {
    const pipelines = ensurePipelineOption(
      [],
      DIAMOND_POLL.poll_pipeline_id,
      DIAMOND_POLL.poll_pipeline_name
    );
    assert.equal(pipelines.length, 1);
    const stages = ensureStageOption(
      [],
      DIAMOND_POLL.poll_pipeline_stage_id,
      DIAMOND_POLL.poll_stage_name
    );
    assert.equal(stages.length, 1);
    assert.equal(stages[0]?.name, DIAMOND_POLL.poll_stage_name);
  });
});

describe("poll stage save round-trip", () => {
  it("preserves poll fields through prepare → echo response → hydrate", () => {
    const submitted = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      ...DIAMOND_POLL,
    });
    const echoed = {
      agent_id: "3c3110ff-a610-48c2-aa98-f680c8c9b9fc",
      ...submitted,
    };
    const hydrated = taskConfigFromRow(echoed);
    assert.equal(hydrated.poll_stage_enabled, true);
    assert.equal(hydrated.poll_pipeline_id, DIAMOND_POLL.poll_pipeline_id);
    assert.equal(hydrated.poll_pipeline_stage_id, DIAMOND_POLL.poll_pipeline_stage_id);
    assert.equal(hydrated.poll_pipeline_name, DIAMOND_POLL.poll_pipeline_name);
    assert.equal(hydrated.poll_stage_name, DIAMOND_POLL.poll_stage_name);
  });

  it("prefers submitted config when server re-read omits poll columns", () => {
    const submitted = prepareTaskConfigForSave({
      ...defaultTaskConfig(),
      ...DIAMOND_POLL,
    });
    const staleServerRow = {
      enabled: false,
      pipeline_automation_enabled: false,
    };
    const resolved = resolveTaskConfigAfterSave(staleServerRow, submitted);
    assert.equal(resolved?.poll_pipeline_id, DIAMOND_POLL.poll_pipeline_id);
    assert.equal(resolved?.poll_pipeline_stage_id, DIAMOND_POLL.poll_pipeline_stage_id);
    assert.equal(resolved?.poll_stage_name, DIAMOND_POLL.poll_stage_name);
  });
});
