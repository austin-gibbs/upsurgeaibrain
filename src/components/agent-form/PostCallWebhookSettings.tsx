"use client";

import { Input, Label, Pill } from "@/components/ui";
import { OUTCOMES, type TaskConfig } from "./types";
import { outcomeLabel } from "@/lib/engine/outcome";

export function PostCallWebhookSettings({
  cfg,
  onChange,
}: {
  cfg: TaskConfig;
  onChange: (patch: Partial<TaskConfig>) => void;
}) {
  return (
    <div className="space-y-5 border-t border-ink-100 pt-5">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">
          HighLevel workflow webhook
        </h3>
        <p className="mt-1 text-xs text-ink-500">
          After each call, send contact and outcome data to a HighLevel Workflow
          Inbound Webhook so you can trigger automations (notifications, pipeline
          moves, etc.).
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
          checked={cfg.post_call_webhook_enabled}
          onChange={(e) =>
            onChange({ post_call_webhook_enabled: e.target.checked })
          }
        />
        <span className="text-sm font-medium text-ink-700">
          Send call data to HighLevel workflow webhook
        </span>
      </label>

      {cfg.post_call_webhook_enabled && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label hint="from your GHL Workflow → Inbound Webhook trigger">
              Webhook URL
            </Label>
            <Input
              value={cfg.post_call_webhook_url ?? ""}
              onChange={(e) =>
                onChange({
                  post_call_webhook_url: e.target.value.trim() || null,
                })
              }
              placeholder="https://services.leadconnectorhq.com/hooks/…"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label hint="leave all unchecked = fire on every outcome">
              Only on these outcomes
            </Label>
            <div className="flex flex-wrap gap-2">
              {OUTCOMES.map((o) => {
                const sel =
                  cfg.post_call_webhook_only_outcomes?.includes(o) ?? false;
                return (
                  <Pill
                    key={o}
                    selected={sel}
                    onClick={() => {
                      const cur = new Set(cfg.post_call_webhook_only_outcomes ?? []);
                      if (cur.has(o)) cur.delete(o);
                      else cur.add(o);
                      const arr = [...cur];
                      onChange({
                        post_call_webhook_only_outcomes: arr.length ? arr : null,
                      });
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
