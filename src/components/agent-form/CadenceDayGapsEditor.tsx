"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button, Input, Label, Select } from "@/components/ui";

const PRESETS: { label: string; gaps: number[] }[] = [
  {
    label: "Standard (0, 1, 2, 3, 5, 7…)",
    gaps: [0, 1, 2, 3, 5, 7, 10, 14, 21, 30],
  },
  {
    label: "Aggressive (0, 0, 1, 2, 3)",
    gaps: [0, 0, 1, 2, 3, 5, 7, 10],
  },
  {
    label: "Conservative (1, 3, 7, 14, 30)",
    gaps: [1, 3, 7, 14, 30, 30, 30],
  },
];

export function CadenceDayGapsEditor({
  gaps,
  onChange,
}: {
  gaps: number[];
  onChange: (gaps: number[]) => void;
}) {
  function updateGap(index: number, days: number) {
    const next = [...gaps];
    next[index] = Math.max(0, Math.floor(days));
    onChange(next);
  }

  function removeGap(index: number) {
    if (gaps.length <= 1) return;
    onChange(gaps.filter((_, i) => i !== index));
  }

  function addGap() {
    const last = gaps[gaps.length - 1] ?? 0;
    onChange([...gaps, last + 1]);
  }

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <Label>Cadence day-gaps</Label>
          <p className="text-xs text-ink-500">
            Days to wait after each call attempt before the next dial. Attempt 1
            can be 0 (same day).
          </p>
        </div>
        <div className="w-full sm:w-64">
          <Select
            value=""
            onChange={(e) => {
              const preset = PRESETS.find((p) => p.label === e.target.value);
              if (preset) onChange([...preset.gaps]);
            }}
          >
            <option value="">Apply preset…</option>
            {PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        {gaps.map((gap, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl border border-ink-200/60 bg-ink-50/30 px-4 py-3"
          >
            <span className="min-w-[7rem] text-sm text-ink-600">
              After attempt {i + 1}
            </span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                className="w-20"
                value={gap}
                onChange={(e) =>
                  updateGap(i, e.target.value === "" ? 0 : Number(e.target.value))
                }
              />
              <span className="text-sm text-ink-500">
                day{gap === 1 ? "" : "s"}
                {i < gaps.length - 1 ? ` → attempt ${i + 2}` : ""}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-8 w-8 p-0 text-ink-400 hover:text-accent-rose-fg"
              onClick={() => removeGap(i)}
              disabled={gaps.length <= 1}
              aria-label={`Remove attempt ${i + 1}`}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
        ))}
      </div>

      <Button type="button" variant="secondary" size="sm" onClick={addGap}>
        <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.75} />
        Add attempt
      </Button>
    </div>
  );
}
