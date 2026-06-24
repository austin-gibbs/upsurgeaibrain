"use client";

import { Input, Label, Pill, Select } from "@/components/ui";
import { OUTCOMES, type TaskConfig } from "./types";
import { outcomeLabel } from "@/lib/engine/outcome";

function NumField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label hint={hint}>{label}</Label>
      <Input
        type="number"
        value={value === null ? "" : value}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    </div>
  );
}

export function TaskSettings({
  cfg,
  users,
  onChange,
}: {
  cfg: TaskConfig;
  users: { id: string; name: string }[];
  onChange: (patch: Partial<TaskConfig>) => void;
}) {
  return (
    <div className="space-y-5">
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
          checked={cfg.enabled}
          onChange={(e) => onChange({ enabled: e.target.checked })}
        />
        <span className="text-sm font-medium text-ink-700">
          Create a CRM task after calls
        </span>
      </label>

      {cfg.enabled && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label hint="{contact_name} and {date} are substituted">
              Task name template
            </Label>
            <Input
              value={cfg.name_template}
              onChange={(e) => onChange({ name_template: e.target.value })}
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
            <Label>Assignee</Label>
            {users.length > 0 ? (
              <Select
                value={cfg.assignee_crm_id ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  const label =
                    users.find((u) => u.id === id)?.name ?? null;
                  onChange({ assignee_crm_id: id, assignee_label: label });
                }}
              >
                <option value="">— Unassigned —</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                placeholder="CRM user id"
                value={cfg.assignee_crm_id ?? ""}
                onChange={(e) =>
                  onChange({
                    assignee_crm_id: e.target.value || null,
                    assignee_label: e.target.value || null,
                  })
                }
              />
            )}
          </div>
          <NumField
            label="Due offset (minutes)"
            hint="from call time"
            value={cfg.due_offset_minutes}
            onChange={(v) => onChange({ due_offset_minutes: v ?? 0 })}
          />
          <div className="space-y-1.5 sm:col-span-2">
            <Label hint="leave all unchecked = every outcome makes a task">
              Only on these outcomes
            </Label>
            <div className="flex flex-wrap gap-2">
              {OUTCOMES.map((o) => {
                const sel = cfg.only_outcomes?.includes(o) ?? false;
                return (
                  <Pill
                    key={o}
                    selected={sel}
                    onClick={() => {
                      const cur = new Set(cfg.only_outcomes ?? []);
                      if (cur.has(o)) cur.delete(o);
                      else cur.add(o);
                      const arr = [...cur];
                      onChange({ only_outcomes: arr.length ? arr : null });
                    }}
                  >
                    {outcomeLabel(o)}
                  </Pill>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
