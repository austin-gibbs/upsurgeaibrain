// =====================================================================
// Zod schemas for the post-call automation admin API. Validates trigger and
// link payloads before they hit Postgres. Kept in the automations domain so
// the condition/action shapes stay in one place with types.ts.
// =====================================================================
import { z } from "zod";

export const conditionOperatorSchema = z.enum([
  "is_true",
  "is_false",
  "eq",
  "neq",
  "contains",
  "exists",
  "not_exists",
  "in",
]);

export const automationConditionSchema = z.object({
  field: z.string().min(1, "condition.field is required"),
  operator: conditionOperatorSchema,
  // value is optional for exists/not_exists/is_true/is_false; string, number,
  // boolean, or an array (for the "in" operator).
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional(),
});

export const automationActionTypeSchema = z.enum([
  "webhook",
  "highlevel_sms",
  "internal_notify",
]);

export const matchTypeSchema = z.enum(["all", "any"]);

export const automationActionConfigSchema = z
  .object({
    url: z.string().url().optional(),
    method: z.enum(["POST", "PUT", "PATCH"]).optional(),
    headers: z.record(z.string()).optional(),
    message_template: z.string().optional(),
    // Which resolved link to attach: either a fixed type or the name of a
    // custom_analysis_data field that carries the type at call time.
    link_type_field: z.string().optional(),
    static_link_type: z.string().optional(),
    // Full custom payload template (deep-rendered) — overrides the default shape.
    payload_template: z.record(z.unknown()).optional(),
  })
  .strict();

export const automationTriggerCreateSchema = z
  .object({
    // Workspace/agent are resolved by name in the route from the URL/body, so
    // the payload itself carries only the trigger definition.
    name: z.string().min(1).max(120),
    description: z.string().max(1000).optional().nullable(),
    enabled: z.boolean().optional().default(true),
    match_type: matchTypeSchema.optional().default("all"),
    conditions: z.array(automationConditionSchema).optional().default([]),
    action_type: automationActionTypeSchema,
    action_config: automationActionConfigSchema.optional().default({}),
    dedupe_window_hours: z.number().int().min(0).max(720).optional().default(24),
    max_attempts: z.number().int().min(1).max(20).optional().default(5),
    only_outcomes: z.array(z.string()).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    // webhook / highlevel_sms need a delivery URL (unless a payload_template is
    // posted to a URL); internal_notify never needs one.
    if (val.action_type !== "internal_notify" && !val.action_config?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `action_config.url is required for action_type="${val.action_type}"`,
        path: ["action_config", "url"],
      });
    }
  });

// PATCH: every field optional, but the same URL invariant is enforced only when
// action_type/action_config are actually being changed (checked in the route
// against the merged row).
export const automationTriggerUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(1000).optional().nullable(),
    enabled: z.boolean().optional(),
    match_type: matchTypeSchema.optional(),
    conditions: z.array(automationConditionSchema).optional(),
    action_type: automationActionTypeSchema.optional(),
    action_config: automationActionConfigSchema.optional(),
    dedupe_window_hours: z.number().int().min(0).max(720).optional(),
    max_attempts: z.number().int().min(1).max(20).optional(),
    only_outcomes: z.array(z.string()).optional().nullable(),
  })
  .strict();

export const automationLinkUpsertSchema = z.object({
  link_type: z.string().min(1).max(80),
  url: z.string().url(),
  label: z.string().max(160).optional().nullable(),
});

export type AutomationTriggerCreateInput = z.infer<typeof automationTriggerCreateSchema>;
export type AutomationTriggerUpdateInput = z.infer<typeof automationTriggerUpdateSchema>;
export type AutomationLinkUpsertInput = z.infer<typeof automationLinkUpsertSchema>;
