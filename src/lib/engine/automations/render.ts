// =====================================================================
// Pure template rendering for action messages/payloads. Supports {{...}}
// placeholders resolved from the call context + the resolved link. Unknown
// placeholders render as empty string (never leak a raw "{{x}}" to a lead).
// =====================================================================
import type { AutomationEvalContext } from "./types";

export interface RenderScope {
  ctx: AutomationEvalContext;
  link: { type: string | null; url: string | null; label: string | null };
}

function lookup(path: string, scope: RenderScope): unknown {
  const parts = path.trim().split(".");
  const head = parts[0];

  if (head === "contact") {
    const key = parts[1] as keyof AutomationEvalContext["contact"];
    return scope.ctx.contact[key];
  }
  if (head === "link") {
    const key = parts[1] as "type" | "url" | "label";
    return scope.link[key];
  }
  if (head === "fields") {
    return scope.ctx.customFields?.[parts[1]];
  }
  switch (head) {
    case "outcome":
      return scope.ctx.outcome;
    case "summary":
      return scope.ctx.summary;
    case "transcript":
      return scope.ctx.transcript;
    default:
      // Bare field name → custom_analysis_data
      return scope.ctx.customFields?.[head];
  }
}

/** Replace every {{ path }} in a string. */
export function renderTemplate(template: string, scope: RenderScope): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const v = lookup(path, scope);
    return v === null || v === undefined ? "" : String(v);
  });
}

/** Deep-render a payload template object (string leaves only). */
export function renderPayload(
  payload: Record<string, unknown>,
  scope: RenderScope
): Record<string, unknown> {
  const walk = (val: unknown): unknown => {
    if (typeof val === "string") return renderTemplate(val, scope);
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) out[k] = walk(v);
      return out;
    }
    return val;
  };
  return walk(payload) as Record<string, unknown>;
}
