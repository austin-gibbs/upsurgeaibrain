// =====================================================================
// Pure condition evaluation. No I/O — takes a trigger's conditions + a call
// context snapshot and returns whether the trigger matches. Kept side-effect
// free so it is fully unit-testable (see conditions.test.ts).
// =====================================================================
import { outcomeMatchesGate } from "../inbound-outcome";
import type {
  AutomationCondition,
  AutomationDirectionScope,
  AutomationEvalContext,
  AutomationTrigger,
  ConditionOperator,
} from "./types";

// Call-context pseudo-fields resolve from the context; anything else resolves
// from custom_analysis_data. This lets a rule match on outcome/summary/
// transcript without those needing to be Retell analysis fields.
function resolveFieldValue(field: string, ctx: AutomationEvalContext): unknown {
  switch (field) {
    case "outcome":
      return ctx.outcome;
    case "summary":
      return ctx.summary;
    case "transcript":
      return ctx.transcript;
    case "direction":
      return ctx.direction ?? "outbound";
    default:
      return ctx.customFields?.[field];
  }
}

// Retell LLM boolean fields sometimes arrive as the strings "true"/"yes".
// Normalize to a real boolean so is_true / is_false behave intuitively.
function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "yes" || s === "y" || s === "1";
  }
  return false;
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function evalOne(cond: AutomationCondition, ctx: AutomationEvalContext): boolean {
  const actual = resolveFieldValue(cond.field, ctx);
  const op: ConditionOperator = cond.operator;

  switch (op) {
    case "is_true":
      return coerceBool(actual);
    case "is_false":
      return !coerceBool(actual);
    case "exists":
      return actual !== null && actual !== undefined && asString(actual) !== "";
    case "not_exists":
      return actual === null || actual === undefined || asString(actual) === "";
    case "eq":
      return asString(actual).trim().toLowerCase() === asString(cond.value).trim().toLowerCase();
    case "neq":
      return asString(actual).trim().toLowerCase() !== asString(cond.value).trim().toLowerCase();
    case "contains":
      return asString(actual).toLowerCase().includes(asString(cond.value).toLowerCase());
    case "in": {
      const list = Array.isArray(cond.value)
        ? cond.value.map((x) => asString(x).trim().toLowerCase())
        : asString(cond.value)
            .split(",")
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean);
      return list.includes(asString(actual).trim().toLowerCase());
    }
    default:
      // Unknown operator: never match (fail safe — don't fire an action we
      // can't reason about).
      return false;
  }
}

/**
 * Does this trigger match the call context?
 *   - direction_scope gate first (all / inbound / outbound).
 *   - only_outcomes gate next (empty/null = any outcome).
 *     On inbound calls, outcomes are canonicalized so outbound enum values
 *     still match (appointment ↔ appointment_booked). Outbound stays exact.
 *   - then match_type: 'all' = every condition, 'any' = at least one.
 *   - an empty conditions array with a passing outcome gate MATCHES (lets an
 *     operator fire purely on outcome, e.g. "on every appointment").
 */
export function triggerMatches(
  trigger: Pick<
    AutomationTrigger,
    "match_type" | "conditions" | "only_outcomes"
  > & { direction_scope?: AutomationDirectionScope | null },
  ctx: AutomationEvalContext
): boolean {
  const scope: AutomationDirectionScope = trigger.direction_scope ?? "all";
  const direction = ctx.direction ?? "outbound";
  if (scope !== "all" && scope !== direction) {
    return false;
  }

  if (
    trigger.only_outcomes &&
    trigger.only_outcomes.length > 0 &&
    !outcomeMatchesGate(String(ctx.outcome), trigger.only_outcomes, direction)
  ) {
    return false;
  }

  const conditions = trigger.conditions ?? [];
  if (conditions.length === 0) return true;

  if (trigger.match_type === "any") {
    return conditions.some((c) => evalOne(c, ctx));
  }
  return conditions.every((c) => evalOne(c, ctx));
}
