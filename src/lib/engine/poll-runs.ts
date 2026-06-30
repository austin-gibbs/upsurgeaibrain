// Persist poll_agent audit rows for Ops review.

type DbClient = ReturnType<typeof import("@/lib/supabase/server").createServiceClient>;

export type PollTriggerSource = "worker" | "manual" | "failover" | "scheduler";

export interface PollRunSnapshot {
  scanned: number;
  eligible: number;
  enqueued: number;
  cancelled?: number;
  tagsStripped?: number;
  skippedReason?: string;
}

export interface WritePollRunInput {
  workspaceId: string;
  agentId: string;
  result: PollRunSnapshot;
  triggerSource: PollTriggerSource;
  testMode?: boolean;
  tagsStripped?: number;
}

export async function writePollRun(
  supabase: DbClient,
  input: WritePollRunInput
): Promise<void> {
  const { error } = await supabase.from("poll_runs").insert({
    workspace_id: input.workspaceId,
    agent_id: input.agentId,
    scanned: input.result.scanned,
    eligible: input.result.eligible,
    enqueued: input.result.enqueued,
    cancelled: input.result.cancelled ?? 0,
    tags_stripped: input.tagsStripped ?? input.result.tagsStripped ?? 0,
    trigger_source: input.triggerSource,
    skipped_reason: input.result.skippedReason ?? null,
    test_mode: input.testMode ?? false,
  });
  if (error) {
    console.error(`[poll] failed to write poll_runs row for agent ${input.agentId}:`, error.message);
  }
}
