"use client";

import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { outcomeLabel } from "@/lib/engine/outcome";
import { Button, Input, Label, Select } from "@/components/ui";
import {
  OUTCOMES,
  type OpportunityCustomField,
  type Pipeline,
  type StageMapEntry,
  type TaskConfig,
} from "./types";

function ruleKey(rule: StageMapEntry, index: number): string {
  return `${rule.outcome}:${rule.call_attempt ?? "any"}:${index}`;
}

export function PipelineStageSettings({
  cfg,
  pipelines,
  map,
  opportunityFields,
  loading,
  opportunityFieldsLoading,
  error,
  opportunityFieldsError,
  onChange,
  onChangeMap,
  onRefresh,
  onRefreshOpportunityFields,
}: {
  cfg: TaskConfig;
  pipelines: Pipeline[];
  map: StageMapEntry[];
  opportunityFields: OpportunityCustomField[];
  loading: boolean;
  opportunityFieldsLoading: boolean;
  error: string | null;
  opportunityFieldsError: string | null;
  onChange: (patch: Partial<TaskConfig>) => void;
  onChangeMap: (map: StageMapEntry[]) => void;
  /** Re-pull pipelines + stages from HighLevel (used by the Refresh button). */
  onRefresh?: () => void;
  /** Re-pull opportunity custom fields from HighLevel. */
  onRefreshOpportunityFields?: () => void;
}) {
  function updateRule(index: number, patch: Partial<StageMapEntry>) {
    onChangeMap(map.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function removeRule(index: number) {
    onChangeMap(map.filter((_, i) => i !== index));
  }

  function addRule() {
    onChangeMap([
      ...map,
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

  const selectedField = opportunityFields.find(
    (f) => f.id === cfg.opportunity_custom_field_id
  );
  const pollPipeline = pipelines.find((p) => p.id === cfg.poll_pipeline_id);

  return (
    <div className="space-y-5 border-t border-ink-100 pt-5">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">
          HighLevel opportunity automation
        </h3>
        <p className="mt-1 text-xs text-ink-500">
          Configure poll-time stage moves and the opportunity custom-field value
          applied whenever UpSurge creates or updates an opportunity.
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
            {!loading && !error && pipelines.length === 0 && (
              <p className="text-xs text-accent-amber-fg">
                No pipelines found. Save valid HighLevel credentials first, then
                reopen this page.
              </p>
            )}
            {pipelines.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Poll pipeline</Label>
                  <Select
                    value={cfg.poll_pipeline_id ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      const p = pipelines.find((p) => p.id === val);
                      onChange({
                        poll_pipeline_id: val || null,
                        poll_pipeline_name: p?.name ?? null,
                        poll_pipeline_stage_id: null,
                        poll_stage_name: null,
                      });
                    }}
                  >
                    <option value="">— Select —</option>
                    {pipelines.map((p) => (
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
                    disabled={!pollPipeline}
                    onChange={(e) => {
                      const val = e.target.value;
                      const s = pollPipeline?.stages.find((s) => s.id === val);
                      onChange({
                        poll_pipeline_stage_id: val || null,
                        poll_stage_name: s?.name ?? null,
                      });
                    }}
                  >
                    <option value="">
                      {pollPipeline ? "— Select —" : "—"}
                    </option>
                    {pollPipeline?.stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Opportunity custom field */}
      <div className="space-y-4 rounded-2xl border border-ink-200/50 bg-ink-50/30 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h4 className="text-sm font-semibold text-ink-900">
              Opportunity AI Agent value
            </h4>
            <p className="mt-1 text-xs text-ink-500">
              Set a dropdown custom field on every opportunity UpSurge creates or
              moves — e.g. AI Agent = Seller Outgoing AI Agent.
            </p>
          </div>
          {onRefreshOpportunityFields && (
            <button
              type="button"
              onClick={onRefreshOpportunityFields}
              disabled={opportunityFieldsLoading}
              title="Re-pull opportunity custom fields from HighLevel"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-600 transition-colors hover:bg-ink-50 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${opportunityFieldsLoading ? "animate-spin" : ""}`}
                strokeWidth={1.75}
              />
              {opportunityFieldsLoading ? "Refreshing…" : "Refresh"}
            </button>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            checked={cfg.opportunity_custom_field_enabled}
            onChange={(e) =>
              onChange({ opportunity_custom_field_enabled: e.target.checked })
            }
          />
          <span className="text-sm font-medium text-ink-700">
            Set opportunity custom field on create/update
          </span>
        </label>

        {cfg.opportunity_custom_field_enabled && (
          <>
            {opportunityFieldsLoading && (
              <p className="text-xs text-ink-500">Loading custom fields…</p>
            )}
            {opportunityFieldsError && (
              <p className="text-xs text-accent-rose-fg">{opportunityFieldsError}</p>
            )}
            {!opportunityFieldsLoading &&
              !opportunityFieldsError &&
              opportunityFields.length === 0 && (
                <p className="text-xs text-accent-amber-fg">
                  No dropdown opportunity fields found. Create one in HighLevel
                  first, then refresh.
                </p>
              )}
            {opportunityFields.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Custom field</Label>
                  <Select
                    value={cfg.opportunity_custom_field_id ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      const field = opportunityFields.find((f) => f.id === val);
                      onChange({
                        opportunity_custom_field_id: val || null,
                        opportunity_custom_field_key: field?.key ?? null,
                        opportunity_custom_field_label: field?.name ?? null,
                        opportunity_custom_field_value: null,
                        opportunity_custom_field_value_label: null,
                      });
                    }}
                  >
                    <option value="">— Select —</option>
                    {opportunityFields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Field value</Label>
                  <Select
                    value={cfg.opportunity_custom_field_value ?? ""}
                    disabled={!selectedField}
                    onChange={(e) => {
                      const val = e.target.value;
                      const opt = selectedField?.options.find((o) => o.value === val);
                      onChange({
                        opportunity_custom_field_value: val || null,
                        opportunity_custom_field_value_label: opt?.label ?? null,
                      });
                    }}
                  >
                    <option value="">
                      {selectedField ? "— Select —" : "—"}
                    </option>
                    {selectedField?.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
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
          {!loading && !error && pipelines.length === 0 && (
            <p className="text-xs text-accent-amber-fg">
              No pipelines found. Save valid HighLevel credentials for this agent
              first, then reopen this page.
            </p>
          )}

          {pipelines.length > 0 && (
            <div className="space-y-3">
              {map.length === 0 && (
                <p className="text-xs text-ink-500">
                  No routing rules yet. Add a rule to map outcomes (and optionally
                  call attempts) to pipeline stages — e.g. No Answer/Voicemail + attempt 1 →
                  Day 1.
                </p>
              )}

              {map.map((rule, index) => {
                const pipeline = pipelines.find((p) => p.id === rule.pipeline_id);
                return (
                  <div
                    key={ruleKey(rule, index)}
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
                            const p = pipelines.find((p) => p.id === val);
                            updateRule(index, {
                              pipeline_id: val,
                              pipeline_name: p?.name ?? null,
                              pipeline_stage_id: "",
                              stage_name: null,
                            });
                          }}
                        >
                          <option value="">— Select —</option>
                          {pipelines.map((p) => (
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
