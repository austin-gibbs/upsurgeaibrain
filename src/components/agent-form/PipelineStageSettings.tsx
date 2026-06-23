"use client";

import { Label, Select } from "@/components/ui";
import {
  OUTCOMES,
  type Pipeline,
  type StageMapEntry,
  type TaskConfig,
} from "./types";

export function PipelineStageSettings({
  cfg,
  pipelines,
  map,
  loading,
  error,
  onChange,
  onChangeMap,
}: {
  cfg: TaskConfig;
  pipelines: Pipeline[];
  map: StageMapEntry[];
  loading: boolean;
  error: string | null;
  onChange: (patch: Partial<TaskConfig>) => void;
  onChangeMap: (map: StageMapEntry[]) => void;
}) {
  function entryFor(outcome: string): StageMapEntry | undefined {
    return map.find((m) => m.outcome === outcome);
  }

  function upsert(outcome: string, patch: Partial<StageMapEntry>) {
    const others = map.filter((m) => m.outcome !== outcome);
    const cur = entryFor(outcome);
    const next: StageMapEntry = {
      outcome,
      pipeline_id: "",
      pipeline_stage_id: "",
      pipeline_name: null,
      stage_name: null,
      ...cur,
      ...patch,
    };
    onChangeMap([...others, next]);
  }

  function remove(outcome: string) {
    onChangeMap(map.filter((m) => m.outcome !== outcome));
  }

  return (
    <div className="space-y-5 border-t border-ink-100 pt-5">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">
          Pipeline routing
        </h3>
        <p className="mt-1 text-xs text-ink-500">
          Move the contact&apos;s HighLevel opportunity to a pipeline stage based
          on the call outcome — automatically, with no HighLevel workflow to
          build. Leave an outcome on &ldquo;No move&rdquo; to skip it.
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
          checked={cfg.pipeline_automation_enabled}
          onChange={(e) =>
            onChange({ pipeline_automation_enabled: e.target.checked })
          }
        />
        <span className="text-sm font-medium text-ink-700">
          Move opportunities by outcome
        </span>
      </label>

      {cfg.pipeline_automation_enabled && (
        <>
          {loading && (
            <p className="text-xs text-ink-500">Loading pipelines…</p>
          )}
          {error && <p className="text-xs text-accent-rose-fg">{error}</p>}
          {!loading && !error && pipelines.length === 0 && (
            <p className="text-xs text-accent-amber-fg">
              No pipelines found. Save valid HighLevel credentials for this agent
              first, then reopen this page.
            </p>
          )}

          {pipelines.length > 0 && (
            <div className="space-y-3">
              {OUTCOMES.map((outcome) => {
                const cur = entryFor(outcome);
                const pipeline = pipelines.find(
                  (p) => p.id === cur?.pipeline_id
                );
                return (
                  <div
                    key={outcome}
                    className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr]"
                  >
                    <div className="space-y-1.5">
                      <Label>{outcome}</Label>
                      <Select
                        value={cur?.pipeline_id ?? ""}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (!val) return remove(outcome);
                          const p = pipelines.find((p) => p.id === val);
                          upsert(outcome, {
                            pipeline_id: val,
                            pipeline_name: p?.name ?? null,
                            pipeline_stage_id: "",
                            stage_name: null,
                          });
                        }}
                      >
                        <option value="">— No move —</option>
                        {pipelines.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label hint="target stage">Stage</Label>
                      <Select
                        value={cur?.pipeline_stage_id ?? ""}
                        disabled={!pipeline}
                        onChange={(e) => {
                          const val = e.target.value;
                          const s = pipeline?.stages.find((s) => s.id === val);
                          upsert(outcome, {
                            pipeline_stage_id: val,
                            stage_name: s?.name ?? null,
                          });
                        }}
                      >
                        <option value="">
                          {pipeline ? "— Select a stage —" : "—"}
                        </option>
                        {pipeline?.stages.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
