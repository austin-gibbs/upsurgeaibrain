"use client";

import { useMemo } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  INBOUND_OUTCOMES,
  inboundOutcomeLabel,
} from "@/lib/engine/inbound-outcome";
import { ensurePipelineOption, ensureStageOption } from "@/lib/pipeline-options";
import { Button, Input, Label, Select } from "@/components/ui";
import type { InboundConfig, InboundRouteEntry, Pipeline } from "./types";

type CrmUserOption = { id: string; name: string; email?: string };

export function InboundAutomationSettings({
  cfg,
  routes,
  pipelines,
  users,
  loading,
  error,
  onChange,
  onChangeRoutes,
  onRefresh,
}: {
  cfg: InboundConfig;
  routes: InboundRouteEntry[];
  pipelines: Pipeline[];
  users: CrmUserOption[];
  loading: boolean;
  error: string | null;
  onChange: (patch: Partial<InboundConfig>) => void;
  onChangeRoutes: (
    routes: InboundRouteEntry[] | ((prev: InboundRouteEntry[]) => InboundRouteEntry[])
  ) => void;
  onRefresh?: () => void;
}) {
  const pipelineOptions = useMemo(() => {
    let opts = [...pipelines];
    opts = ensurePipelineOption(
      opts,
      cfg.default_pipeline_id,
      cfg.default_pipeline_name
    );
    for (const rule of routes) {
      opts = ensurePipelineOption(opts, rule.pipeline_id, rule.pipeline_name);
    }
    return opts;
  }, [pipelines, cfg, routes]);

  const defaultPipeline = pipelineOptions.find(
    (p) => p.id === cfg.default_pipeline_id
  );
  const defaultStageOptions = ensureStageOption(
    defaultPipeline?.stages ?? [],
    cfg.default_pipeline_stage_id,
    cfg.default_stage_name
  );

  function updateRule(index: number, patch: Partial<InboundRouteEntry>) {
    onChangeRoutes((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  }

  function removeRule(index: number) {
    onChangeRoutes((prev) => prev.filter((_, i) => i !== index));
  }

  function addRule() {
    onChangeRoutes((prev) => [
      ...prev,
      {
        outcome: "interested",
        pipeline_id: cfg.default_pipeline_id,
        pipeline_stage_id: cfg.default_pipeline_stage_id,
        pipeline_name: cfg.default_pipeline_name,
        stage_name: cfg.default_stage_name,
        opportunity_status: "open",
        tag: null,
        remove_tags: [],
      },
    ]);
  }

  const outcomeChoices = [
    ...INBOUND_OUTCOMES.map((o) => ({
      value: o,
      label: inboundOutcomeLabel(o),
    })),
    { value: "*", label: "Any outcome (catch-all)" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">Inbound automation</h3>
        <p className="mt-1 text-xs text-ink-500">
          After an inbound call ends, tag the lead and create or update its
          HighLevel opportunity into a mapped pipeline stage based on the call
          outcome.
        </p>
      </div>

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-ink-300"
          checked={cfg.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span className="text-sm text-ink-800">
          Enable inbound automation for this agent
        </span>
      </label>

      {!cfg.enabled ? (
        <p className="rounded-xl bg-ink-50 px-4 py-3 text-xs text-ink-500">
          When disabled, the legacy inbound handler runs (if applicable). Turn
          this on for HighLevel tag + opportunity writeback.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label hint="Applied on every inbound call after it ends">
                Always tag
              </Label>
              <Input
                value={cfg.always_tag ?? ""}
                onChange={(e) =>
                  onChange({ always_tag: e.target.value.trim() || null })
                }
                placeholder="AI Inbound Call"
              />
            </div>
            <div className="space-y-1.5">
              <Label hint="CRM source label for newly created contacts">
                New contact source
              </Label>
              <Input
                value={cfg.new_contact_source}
                onChange={(e) =>
                  onChange({ new_contact_source: e.target.value || "AI Inbound Call" })
                }
              />
            </div>
          </div>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-ink-300"
              checked={cfg.create_contact_if_missing}
              onChange={(e) =>
                onChange({ create_contact_if_missing: e.target.checked })
              }
            />
            <span className="text-sm text-ink-800">
              Create a HighLevel contact when the caller&apos;s phone is new
            </span>
          </label>

          <div className="space-y-1.5">
            <Label hint="Skip CRM writeback for hangups shorter than this">
              Min duration (seconds)
            </Label>
            <Input
              type="number"
              min={0}
              value={cfg.min_duration_seconds}
              onChange={(e) =>
                onChange({
                  min_duration_seconds: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </div>

          {/* Pipeline defaults */}
          <div className="space-y-4 rounded-2xl border border-ink-200/50 bg-ink-50/30 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-semibold text-ink-900">
                  Pipeline routing
                </h4>
                <p className="mt-1 text-xs text-ink-500">
                  Create or update the contact&apos;s opportunity after each
                  inbound call.
                </p>
              </div>
              {onRefresh && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRefresh}
                  disabled={loading}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              )}
            </div>

            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-ink-300"
                checked={cfg.pipeline_automation_enabled}
                onChange={(e) =>
                  onChange({ pipeline_automation_enabled: e.target.checked })
                }
              />
              <span className="text-sm text-ink-800">
                Move opportunities to a pipeline stage
              </span>
            </label>

            {error && (
              <p className="rounded-xl bg-accent-rose-bg px-3 py-2 text-xs text-accent-rose-fg">
                {error}
              </p>
            )}

            {cfg.pipeline_automation_enabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Default pipeline</Label>
                  <Select
                    value={cfg.default_pipeline_id ?? ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      const p = pipelineOptions.find((x) => x.id === id);
                      onChange({
                        default_pipeline_id: id,
                        default_pipeline_name: p?.name ?? null,
                        default_pipeline_stage_id: null,
                        default_stage_name: null,
                      });
                    }}
                  >
                    <option value="">Select pipeline…</option>
                    {pipelineOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Default stage (catch-all)</Label>
                  <Select
                    value={cfg.default_pipeline_stage_id ?? ""}
                    disabled={!cfg.default_pipeline_id}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      const s = defaultStageOptions.find((x) => x.id === id);
                      onChange({
                        default_pipeline_stage_id: id,
                        default_stage_name: s?.name ?? null,
                      });
                    }}
                  >
                    <option value="">Select stage…</option>
                    {defaultStageOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}

            {/* Outcome rules */}
            {cfg.pipeline_automation_enabled && (
              <div className="space-y-3 border-t border-ink-100 pt-4">
                <div className="flex items-center justify-between">
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Outcome rules
                  </h5>
                  <Button type="button" variant="ghost" size="sm" onClick={addRule}>
                    <Plus className="h-3.5 w-3.5" />
                    Add rule
                  </Button>
                </div>
                {routes.length === 0 && (
                  <p className="text-xs text-ink-400">
                    No outcome overrides — every call uses the default stage
                    above. Add a rule to route a specific outcome to a different
                    stage and/or tag.
                  </p>
                )}
                {routes.map((rule, index) => {
                  const rulePipeline = pipelineOptions.find(
                    (p) => p.id === rule.pipeline_id
                  );
                  const stageOpts = ensureStageOption(
                    rulePipeline?.stages ?? [],
                    rule.pipeline_stage_id,
                    rule.stage_name
                  );
                  return (
                    <div
                      key={index}
                      className="space-y-3 rounded-xl border border-ink-200/60 bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="grid flex-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label>Outcome</Label>
                            <Select
                              value={rule.outcome}
                              onChange={(e) =>
                                updateRule(index, { outcome: e.target.value })
                              }
                            >
                              {outcomeChoices.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Opportunity status</Label>
                            <Select
                              value={rule.opportunity_status ?? ""}
                              onChange={(e) =>
                                updateRule(index, {
                                  opportunity_status: (e.target.value ||
                                    null) as InboundRouteEntry["opportunity_status"],
                                })
                              }
                            >
                              <option value="">(unchanged)</option>
                              <option value="open">Open</option>
                              <option value="won">Won</option>
                              <option value="lost">Lost</option>
                              <option value="abandoned">Abandoned</option>
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Pipeline</Label>
                            <Select
                              value={rule.pipeline_id ?? ""}
                              onChange={(e) => {
                                const id = e.target.value || null;
                                const p = pipelineOptions.find((x) => x.id === id);
                                updateRule(index, {
                                  pipeline_id: id,
                                  pipeline_name: p?.name ?? null,
                                  pipeline_stage_id: null,
                                  stage_name: null,
                                });
                              }}
                            >
                              <option value="">Use default</option>
                              {pipelineOptions.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Stage</Label>
                            <Select
                              value={rule.pipeline_stage_id ?? ""}
                              disabled={!rule.pipeline_id}
                              onChange={(e) => {
                                const id = e.target.value || null;
                                const s = stageOpts.find((x) => x.id === id);
                                updateRule(index, {
                                  pipeline_stage_id: id,
                                  stage_name: s?.name ?? null,
                                });
                              }}
                            >
                              <option value="">Use default</option>
                              {stageOpts.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Outcome tag</Label>
                            <Input
                              value={rule.tag ?? ""}
                              onChange={(e) =>
                                updateRule(index, {
                                  tag: e.target.value.trim() || null,
                                })
                              }
                              placeholder="optional"
                            />
                          </div>
                          <div className="space-y-1">
                            <Label hint="Comma-separated">Remove tags</Label>
                            <Input
                              value={(rule.remove_tags ?? []).join(", ")}
                              onChange={(e) =>
                                updateRule(index, {
                                  remove_tags: e.target.value
                                    .split(",")
                                    .map((t) => t.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder="stale-tag-1, stale-tag-2"
                            />
                          </div>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeRule(index)}
                          aria-label="Remove rule"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-ink-400" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Assignee + task */}
          <div className="space-y-4 rounded-2xl border border-ink-200/50 bg-ink-50/30 p-4">
            <h4 className="text-sm font-semibold text-ink-900">
              Assignment &amp; follow-up task
            </h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Assignee mode</Label>
                <Select
                  value={cfg.assignee_mode}
                  onChange={(e) =>
                    onChange({
                      assignee_mode: e.target.value as InboundConfig["assignee_mode"],
                    })
                  }
                >
                  <option value="fixed">Fixed user(s)</option>
                  <option value="dialed_line">By dialed line</option>
                  <option value="none">None</option>
                </Select>
              </div>
              {cfg.assignee_mode !== "none" && (
                <div className="space-y-1.5">
                  <Label hint="Comma-separated CRM user ids, or pick one">
                    Assignee
                  </Label>
                  {users.length > 0 ? (
                    <Select
                      value={cfg.assignee_crm_id?.split(",")[0]?.trim() ?? ""}
                      onChange={(e) =>
                        onChange({
                          assignee_crm_id: e.target.value || null,
                        })
                      }
                    >
                      <option value="">Select user…</option>
                      {users.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                          {u.email ? ` (${u.email})` : ""}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      value={cfg.assignee_crm_id ?? ""}
                      onChange={(e) =>
                        onChange({
                          assignee_crm_id: e.target.value.trim() || null,
                        })
                      }
                      placeholder="HighLevel user id"
                    />
                  )}
                </div>
              )}
            </div>

            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-ink-300"
                checked={cfg.task_enabled}
                onChange={(e) => onChange({ task_enabled: e.target.checked })}
              />
              <span className="text-sm text-ink-800">
                Create a follow-up task after the call
              </span>
            </label>

            {cfg.task_enabled && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Task name template</Label>
                  <Input
                    value={cfg.task_name_template}
                    onChange={(e) =>
                      onChange({ task_name_template: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Task type</Label>
                  <Input
                    value={cfg.task_type}
                    onChange={(e) => onChange({ task_type: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Due in (minutes)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={cfg.task_due_offset_minutes}
                    onChange={(e) =>
                      onChange({
                        task_due_offset_minutes: Math.max(
                          0,
                          Number(e.target.value) || 0
                        ),
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
