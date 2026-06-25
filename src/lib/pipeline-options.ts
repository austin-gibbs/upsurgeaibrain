import type { Pipeline, StageMapEntry, TaskConfig } from "@/components/agent-form/types";

function ensurePipeline(
  byId: Map<string, Pipeline>,
  pipelineId: string,
  pipelineName: string | null
): Pipeline {
  const existing = byId.get(pipelineId);
  if (existing) {
    if (!existing.name && pipelineName) existing.name = pipelineName;
    return existing;
  }
  const pipeline: Pipeline = {
    id: pipelineId,
    name: pipelineName ?? pipelineId,
    stages: [],
  };
  byId.set(pipelineId, pipeline);
  return pipeline;
}

function ensureStage(
  pipeline: Pipeline,
  stageId: string,
  stageName: string | null
): void {
  if (pipeline.stages.some((s) => s.id === stageId)) return;
  pipeline.stages.push({
    id: stageId,
    name: stageName ?? stageId,
  });
}

/**
 * Merge HighLevel pipelines from the API with poll-stage config and outcome
 * routing rules so saved IDs always appear in dropdowns after reload.
 */
export function mergePipelinesForRouting(
  pipelines: Pipeline[],
  cfg: TaskConfig,
  stageMap: StageMapEntry[]
): Pipeline[] {
  const byId = new Map<string, Pipeline>();
  for (const pipeline of pipelines) {
    byId.set(pipeline.id, {
      ...pipeline,
      stages: [...pipeline.stages],
    });
  }

  const pollPipelineId = cfg.poll_pipeline_id?.trim();
  if (pollPipelineId) {
    const pollPipeline = ensurePipeline(byId, pollPipelineId, cfg.poll_pipeline_name);
    const pollStageId = cfg.poll_pipeline_stage_id?.trim();
    if (pollStageId) {
      ensureStage(pollPipeline, pollStageId, cfg.poll_stage_name);
    }
  }

  for (const rule of stageMap) {
    const pipelineId = rule.pipeline_id?.trim();
    if (!pipelineId) continue;
    const pipeline = ensurePipeline(byId, pipelineId, rule.pipeline_name);
    const stageId = rule.pipeline_stage_id?.trim();
    if (stageId) {
      ensureStage(pipeline, stageId, rule.stage_name);
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}
