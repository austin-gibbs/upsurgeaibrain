"use client";

import { Input, Label } from "@/components/ui";
import type { CallConfig } from "./types";

function NumField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label hint={hint}>{label}</Label>
      <Input
        type="number"
        value={value === null ? "" : value}
        placeholder={placeholder}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    </div>
  );
}

export function CallSettings({
  cfg,
  onChange,
}: {
  cfg: CallConfig;
  onChange: (patch: Partial<CallConfig>) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <NumField
        label="Max calls per day"
        value={cfg.max_calls_per_day}
        onChange={(v) => onChange({ max_calls_per_day: v ?? 0 })}
      />
      <NumField
        label="Max total calls"
        hint="blank = unlimited"
        value={cfg.max_total_calls}
        onChange={(v) => onChange({ max_total_calls: v })}
        placeholder="unlimited"
      />
      <NumField
        label="Max attempts per contact"
        value={cfg.max_attempts_per_contact}
        onChange={(v) => onChange({ max_attempts_per_contact: v ?? 0 })}
      />
      <NumField
        label="Drip spacing (seconds)"
        hint="gap between dials"
        value={cfg.drip_seconds}
        onChange={(v) => onChange({ drip_seconds: v ?? 0 })}
      />
      <div className="space-y-1.5">
        <Label>Call window start</Label>
        <Input
          type="time"
          value={cfg.call_window_start}
          onChange={(e) => onChange({ call_window_start: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Call window end</Label>
        <Input
          type="time"
          value={cfg.call_window_end}
          onChange={(e) => onChange({ call_window_end: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label hint="when the daily poll fires">Daily run at</Label>
        <Input
          type="time"
          value={cfg.daily_run_at}
          onChange={(e) => onChange({ daily_run_at: e.target.value })}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label hint="days after each attempt before the next; comma-separated">
          Cadence day-gaps
        </Label>
        <Input
          value={cfg.cadence_day_gaps.join(", ")}
          onChange={(e) =>
            onChange({
              cadence_day_gaps: e.target.value
                .split(",")
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n)),
            })
          }
        />
      </div>
    </div>
  );
}
