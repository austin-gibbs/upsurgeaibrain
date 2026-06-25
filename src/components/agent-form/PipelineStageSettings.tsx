"use client";

import { useMemo } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { outcomeLabel } from "@/lib/engine/outcome";
import { mergePipelinesForRouting, ensurePipelineOption, ensureStageOption } from "@/lib/pipeline-options";
import { Button, Input, Label, Select } from "@/components/ui";
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
  onRefresh,
}: {
  cfg: TaskConfig;
  pipelines: Pipeline[];
  map: StageMapEntry[];
  loading: boolean;
  error: string | null;
  onChange: (patch: Partial<TaskConfig>) => void;
  onChangeMap: (
    map: StageMapEntry[] | ((prev: StageMapEntry[]) => StageMapEntry[])
  ) => void;
  /** Re-pull pipelines + stages from HighLevel (used by the Refresh button). */
  onRefresh?: () => void;
}) {
  const pipelineOptions = useMemo(
    () => mergePipelinesForRouting(pipelines, cfg, map),
    [pipelines, cfg, map]
  );

  function updateRule(index: number, patch: Partial<StageMapEntry>) {
    onChangeMap((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  function removeRule(index: number) {
    onChangeMap((prev) => prev.filter((_, i) => i !== index));
  }

  function addRule() {
    onChangeMap((prev) => [
      ...prev,
      {
        outcome: "no_answer_voicemail",
        call_attempt: null,
        pipeline_id: "",
        pipeline_stage_id: "",
        pipeline_name: null,
        stage_name: null,
      },
    ]);
  }

  const pollPipeline = pipelineOptions.find((p) => p.id === cfg.poll_pipeline_id);
  const pollPipelineOptions = ensurePipelineOption(
    pipelineOptions,
    cfg.poll_pipeline_id,
    cfg.poll_pipeline_name
  );
  const pollStageOptions = ensureStageOption(
    pollPipeline?.stages ?? [],
    cfg.poll_pipeline_stage_id,
    cfg.poll_stage_name
  );
  const showPollSelectors =
    pipelineOptions.length > 0 || Boolean(cfg.poll_pipeline_id);
  const showOutcomeRules =
    loading || pipelineOptions.length > 0 || map.length > 0;

  return (
    <div className="space-y-5 border-t border-ink-100 pt-5">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">
          Pipeline stage routing
        </h3>
        <p className="mt-1 text-xs text-ink-500">
          Move opportunities to specific pipeline stages on poll and by call
          outcome.
        </p>
      </div>

      {/* Poll stage routing */}
      <div className="space-y-4 rounded-2xl border border-ink-200/50 bg-ink-50/30 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-ink-900">Poll stage</h4>
            <p className="mt-1 text-xs text-ink-500">
              When a poll enqueues calls, move each queued contact&apos;s
              opportunity into this stage before dialing begins.
            </p>
          </div>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              title="Re-pull pipelines & stages from HighLevel"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            checked={cfg.poll_stage_enabled}
            onChange={(e) => onChange({ poll_stage_enabled: e.target.checked })}
          />
          <span className="text-sm font-medium text-ink-700">
            Move opportunities when poll queues calls
          </span>
        </label>

        {cfg.poll_stage_enabled && (
          <>
            {loading && (
              <p className="text-xs text-ink-500">Loading pipelines…</p>
            )}
            {error && <p className="text-xs text-accent-rose-fg">{error}</p>}
            {!loading && !error && pipelineOptions.length === 0 && (
              <p className="text-xs text-accent-amber-fg">
                No pipelines found. Save valid HighLevel credentials first, then
                reopen this page.
              </p>
            )}
            {showPollSelectors && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Poll pipeline</Label>
                  <Select
                    value={cfg.poll_pipeline_id ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      const p = pollPipelineOptions.find((p) => p.id === val);
                      onChange({
                        poll_pipeline_id: val || null,
                        poll_pipeline_name: p?.name ?? null,
                        poll_pipeline_stage_id: null,
                        poll_stage_name: null,
                      });
                    }}
                  >
                    <option value="">— Select —</option>
                    {pollPipelineOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Poll stage</Label>
                  <Select
                    value={cfg.poll_pipeline_stage_id ?? ""}
                    disabled={!cfg.poll_pipeline_id}
                    onChange={(e) => {
                      const val = e.target.value;
                      const s = pollStageOptions.find((s) => s.id === val);
                      onChange({
                        poll_pipeline_stage_id: val || null,
                        poll_stage_name: s?.name ?? null,
                      });
                    }}
                  >
                    <option value="">
                      {cfg.poll_pipeline_id ? "— Select —" : "—"}
                    </option>
                    {pollStageOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
            {cfg.poll_pipeline_name && cfg.poll_stage_name && (
              <p className="text-xs text-ink-500">
                Selected: {cfg.poll_pipeline_name} → {cfg.poll_stage_name}
              </p>
            )}
          </>
        )}
      </div>

      {/* Outcome-based pipeline routing */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-semibold text-ink-900">
            Pipeline routing by outcome
          </h4>
          <p className="mt-1 text-xs text-ink-500">
            Move the contact&apos;s HighLevel opportunity to a pipeline stage based
            on call outcome — and optionally the call attempt number. Leave
            &ldquo;Call attempt&rdquo; blank for a catch-all rule (e.g. appointment
            on any attempt). More specific attempt rules win over catch-alls.
          </p>
        </div>
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
          {!loading && !error && pipelineOptions.length === 0 && map.length === 0 && (
            <p className="text-xs text-accent-amber-fg">
              No pipelines found. Save valid HighLevel credentials for this agent
              first, then reopen this page.
            </p>
          )}

          {showOutcomeRules && (
            <div className="space-y-3">
              {map.length === 0 && !loading && (
                <p className="text-xs text-ink-500">
                  No routing rules yet. Add a rule to map outcomes (and optionally
                  call attempts) to pipeline stages — e.g. No Answer/Voicemail + attempt 1 →
                  Day 1.
                </p>
              )}

              {map.map((rule, index) => {
                const pipeline = pipelineOptions.find((p) => p.id === rule.pipeline_id);
                return (
                  <div
                    key={`rule-${index}`}
                    className="rounded-2xl border border-ink-200/50 bg-ink-50/30 p-4"
                  >
                    <div className="grid items-end gap-3 sm:grid-cols-[1fr_100px_1fr_1fr_auto]">
                      <div className="space-y-1.5">
                        <Label>Outcome</Label>
                        <Select
                          value={rule.outcome}
                          onChange={(e) =>
                            updateRule(index, { outcome: e.target.value })
                          }
                        >
                          {OUTCOMES.map((o) => (
                            <option key={o} value={o}>
                              {outcomeLabel(o)}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label hint="blank = any">Call attempt</Label>
                        <Input
                          type="number"
                          min={1}
                          placeholder="Any"
                          value={rule.call_attempt ?? ""}
                          onChange={(e) => {
                            const raw = e.target.value.trim();
                            updateRule(index, {
                              call_attempt: raw ? Number(raw) : null,
                            });
                          }}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>Pipeline</Label>
                        <Select
                          value={rule.pipeline_id}
                          onChange={(e) => {
                            const val = e.target.value;
                            const p = pipelineOptions.find((p) => p.id === val);
                            updateRule(index, {
                              pipeline_id: val,
                              pipeline_name: p?.name ?? null,
                              pipeline_stage_id: "",
                              stage_name: null,
                            });
                          }}
                        >
                          <option value="">— Select —</option>
                          {pipelineOptions.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Stage</Label>
                        <Select
                          value={rule.pipeline_stage_id}
                          disabled={!pipeline}
                          onChange={(e) => {
                            const val = e.target.value;
                            const s = pipeline?.stages.find((s) => s.id === val);
                            updateRule(index, {
                              pipeline_stage_id: val,
                              stage_name: s?.name ?? null,
                            });
                          }}
                        >
                          <option value="">
                            {pipeline ? "— Select —" : "—"}
                          </option>
                          {pipeline?.stages.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRule(index)}
                        className="mb-0.5 inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-400 transition-colors hover:bg-accent-rose-bg hover:text-accent-rose-fg"
                        title="Remove rule"
                      >
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                );
              })}

              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={addRule}
                disabled={loading && pipelineOptions.length === 0}
              >
                <Plus className="h-4 w-4" strokeWidth={1.75} />
                Add routing rule
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
