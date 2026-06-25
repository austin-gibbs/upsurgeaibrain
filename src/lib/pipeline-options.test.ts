import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultTaskConfig } from "@/components/agent-form/types";
import { mergePipelinesForRouting } from "@/lib/pipeline-options";

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
});
