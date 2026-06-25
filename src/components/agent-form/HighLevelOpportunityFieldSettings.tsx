"use client";

import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { Input, Label, Select } from "@/components/ui";
import type { OpportunityCustomField, TaskConfig } from "./types";

function mergeOpportunityFields(
  fields: OpportunityCustomField[],
  cfg: TaskConfig
): OpportunityCustomField[] {
  const savedId = cfg.opportunity_custom_field_id?.trim();
  if (!savedId || fields.some((f) => f.id === savedId)) return fields;

  const savedOptions = cfg.opportunity_custom_field_value
    ? [
        {
          label:
            cfg.opportunity_custom_field_value_label ??
            cfg.opportunity_custom_field_value,
          value: cfg.opportunity_custom_field_value,
        },
      ]
    : [];

  return [
    ...fields,
    {
      id: savedId,
      key: cfg.opportunity_custom_field_key,
      name: cfg.opportunity_custom_field_label ?? savedId,
      dataType: "unknown",
      options: savedOptions,
    },
  ];
}

export function HighLevelOpportunityFieldSettings({
  cfg,
  fields,
  loading,
  error,
  onChange,
  onRefresh,
}: {
  cfg: TaskConfig;
  fields: OpportunityCustomField[];
  loading: boolean;
  error: string | null;
  onChange: (patch: Partial<TaskConfig>) => void;
  onRefresh?: () => void;
}) {
  const fieldOptions = useMemo(
    () => mergeOpportunityFields(fields, cfg),
    [fields, cfg]
  );
  const selectedField = fieldOptions.find(
    (f) =>
      f.id === cfg.opportunity_custom_field_id ||
      (cfg.opportunity_custom_field_key &&
        f.key === cfg.opportunity_custom_field_key)
  );
  const useManualField =
    fieldOptions.length === 0 && !loading && !cfg.opportunity_custom_field_id;

  return (
    <div className="space-y-4 rounded-2xl border border-ink-200/50 bg-ink-50/30 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm font-semibold text-ink-900">
            Opportunity custom field
          </h4>
          <p className="mt-1 text-xs text-ink-500">
            Choose the HighLevel opportunity dropdown to set on every create or
            stage update — e.g. AI Agent = Seller Outgoing AI Agent.
          </p>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="Re-pull opportunity custom fields from HighLevel"
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
          checked={cfg.opportunity_custom_field_enabled}
          onChange={(e) =>
            onChange({ opportunity_custom_field_enabled: e.target.checked })
          }
        />
        <span className="text-sm font-medium text-ink-700">
          Apply this field when UpSurge creates or updates opportunities
        </span>
      </label>

      {loading && <p className="text-xs text-ink-500">Loading custom fields…</p>}
      {error && <p className="text-xs text-accent-rose-fg">{error}</p>}

      {!loading && !useManualField && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Opportunity field</Label>
            <Select
              value={cfg.opportunity_custom_field_id ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                const field = fieldOptions.find((f) => f.id === val);
                onChange({
                  opportunity_custom_field_id: val || null,
                  opportunity_custom_field_key: field?.key ?? null,
                  opportunity_custom_field_label: field?.name ?? null,
                  opportunity_custom_field_value: null,
                  opportunity_custom_field_value_label: null,
                  ...(val ? { opportunity_custom_field_enabled: true } : {}),
                });
              }}
            >
              <option value="">— Select field —</option>
              {fieldOptions.map((f) => (
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
                  ...(val ? { opportunity_custom_field_enabled: true } : {}),
                });
              }}
            >
              <option value="">
                {selectedField ? "— Select value —" : "—"}
              </option>
              {selectedField?.options.map((o) => (
                <option key={`${o.value}:${o.label}`} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            {selectedField && selectedField.options.length === 0 && (
              <p className="text-xs text-accent-amber-fg">
                No dropdown values returned from HighLevel for this field. Click
                Refresh, or enter the exact value manually below.
              </p>
            )}
          </div>
        </div>
      )}

      {!loading && !useManualField && selectedField && selectedField.options.length === 0 && (
        <div className="space-y-1.5">
          <Label hint="exact dropdown label from HighLevel">Field value (manual)</Label>
          <Input
            value={cfg.opportunity_custom_field_value ?? ""}
            onChange={(e) =>
              onChange({
                opportunity_custom_field_value: e.target.value.trim() || null,
                opportunity_custom_field_value_label:
                  e.target.value.trim() || null,
                ...(e.target.value.trim()
                  ? { opportunity_custom_field_enabled: true }
                  : {}),
              })
            }
            placeholder="Seller Outgoing AI Agent"
          />
        </div>
      )}

      {!loading && useManualField && (
        <div className="space-y-3">
          <p className="text-xs text-accent-amber-fg">
            Could not load dropdown fields from HighLevel. Enter the field ID and
            value manually (from HighLevel Settings → Custom Fields), or click
            Refresh after reconnecting OAuth.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label hint="from HighLevel custom field settings">Field ID</Label>
              <Input
                value={cfg.opportunity_custom_field_id ?? ""}
                onChange={(e) =>
                  onChange({
                    opportunity_custom_field_id: e.target.value.trim() || null,
                    ...(e.target.value.trim()
                      ? { opportunity_custom_field_enabled: true }
                      : {}),
                  })
                }
                placeholder="cf_…"
              />
            </div>
            <div className="space-y-1.5">
              <Label hint="exact dropdown label">Field value</Label>
              <Input
                value={cfg.opportunity_custom_field_value ?? ""}
                onChange={(e) =>
                  onChange({
                    opportunity_custom_field_value: e.target.value.trim() || null,
                    opportunity_custom_field_value_label:
                      e.target.value.trim() || null,
                    ...(e.target.value.trim()
                      ? { opportunity_custom_field_enabled: true }
                      : {}),
                  })
                }
                placeholder="Seller Outgoing AI Agent"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label hint="optional">Field key</Label>
            <Input
              value={cfg.opportunity_custom_field_key ?? ""}
              onChange={(e) =>
                onChange({
                  opportunity_custom_field_key: e.target.value.trim() || null,
                })
              }
              placeholder="opportunity.ai_agent"
            />
          </div>
        </div>
      )}

      {cfg.opportunity_custom_field_label && cfg.opportunity_custom_field_value_label && (
        <p className="text-xs text-ink-500">
          Selected: {cfg.opportunity_custom_field_label} ={" "}
          {cfg.opportunity_custom_field_value_label}
        </p>
      )}
    </div>
  );
}
