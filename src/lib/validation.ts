// Zod schemas for the workspace setup wizard payload.
import { z } from "zod";
import { normalizeHHMM } from "@/lib/hhmm";

const hhmmSchema = z.preprocess(
  (val) => (typeof val === "string" ? normalizeHHMM(val) : val),
  z.string().regex(/^\d{2}:\d{2}$/)
);

export const crmCredentialsSchema = z.union([
  z.object({ apiKey: z.string().min(10) }), // FUB
  z.object({
    // HighLevel. refreshToken/expiresAt are present when connected via OAuth
    // (enables auto-refresh); absent for a legacy hand-pasted static token.
    accessToken: z.string().min(10),
    locationId: z.string().min(1),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
  }),
]);

/** Base URL for CRM contact pages (e.g. https://nilpatel.followupboss.com). */
export const crmAccountUrlSchema = z
  .string()
  .trim()
  .url({ message: "Enter a valid URL like https://youraccount.followupboss.com" })
  .optional()
  .nullable();

/** Retell credentials stored per inbound agent. webhookSecret is optional. */
export const retellCredentialsSchema = z.object({
  apiKey: z.string().min(10),
  webhookSecret: z.string().min(1).optional(),
});

// Matches the call_outcome enum in the database so task-config outcome
// filters are typed correctly when inserted.
export const callOutcomeSchema = z.enum([
  "no_answer_voicemail",
  "appointment",
  "not_interested",
  "dnd",
  "interested_no_appointment",
  "follow_up",
  "error",
]);

export const callConfigSchema = z.object({
  max_total_calls: z.number().int().positive().nullable().default(null),
  max_calls_per_day: z.number().int().positive().default(100),
  max_attempts_per_contact: z.number().int().positive().default(10),
  call_window_start: hhmmSchema.default("09:00"),
  call_window_end: hhmmSchema.default("18:00"),
  daily_run_at: hhmmSchema.default("09:00"),
  drip_seconds: z.number().int().min(1).default(60),
  cadence_day_gaps: z
    .array(z.number().int().min(0))
    .min(1)
    .default([0, 1, 2, 3, 5, 7, 10, 14, 21, 30]),
});

export const taskConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    name_template: z.string().default("UpSurge AI Call Review for {contact_name} on {date}"),
    task_type: z.string().default("Follow Up"),
    assignee_crm_id: z.string().nullable().default(null),
    assignee_label: z.string().nullable().default(null),
    due_offset_minutes: z.number().int().default(0),
    due_at_time: z
      .union([z.string().regex(/^\d{1,2}:\d{2}$/), z.literal(""), z.null()])
      .default(null)
      .transform((v) => (v === "" ? null : v)),
    only_outcomes: z.array(callOutcomeSchema).nullable().default(null),
    post_call_webhook_enabled: z.boolean().default(false),
    post_call_webhook_url: z
      .union([z.string().url(), z.literal(""), z.null()])
      .default(null)
      .transform((v) => (v === "" ? null : v)),
    post_call_webhook_only_outcomes: z.array(callOutcomeSchema).nullable().default(null),
    pipeline_automation_enabled: z.boolean().default(false),
    poll_stage_enabled: z.boolean().default(false),
    poll_pipeline_id: z.string().nullable().default(null),
    poll_pipeline_stage_id: z.string().nullable().default(null),
    poll_pipeline_name: z.string().nullable().default(null),
    poll_stage_name: z.string().nullable().default(null),
    opportunity_custom_field_enabled: z.boolean().default(false),
    opportunity_custom_field_id: z.string().nullable().default(null),
    opportunity_custom_field_key: z.string().nullable().default(null),
    opportunity_custom_field_label: z.string().nullable().default(null),
    opportunity_custom_field_value: z.string().nullable().default(null),
    opportunity_custom_field_value_label: z.string().nullable().default(null),
  })
  .superRefine((val, ctx) => {
    if (val.post_call_webhook_enabled && !val.post_call_webhook_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["post_call_webhook_url"],
        message: "Webhook URL is required when post-call webhook is enabled.",
      });
    }
    if (
      val.poll_stage_enabled &&
      (!val.poll_pipeline_id?.trim() || !val.poll_pipeline_stage_id?.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["poll_pipeline_stage_id"],
        message: "Poll stage requires both a pipeline and stage when enabled.",
      });
    }
    if (
      val.opportunity_custom_field_enabled &&
      (!val.opportunity_custom_field_id?.trim() || !val.opportunity_custom_field_value?.trim())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["opportunity_custom_field_value"],
        message: "Opportunity custom field requires a field and value when enabled.",
      });
    }
  });

/**
 * One outcome -> pipeline stage routing rule. The PATCH endpoint accepts the
 * full set for an agent and replaces the stored map. pipeline_name/stage_name
 * are display-label caches and are optional.
 */
export const pipelineStageMapEntrySchema = z.object({
  outcome: callOutcomeSchema,
  call_attempt: z.number().int().positive().nullable().default(null),
  pipeline_id: z.string().min(1),
  pipeline_stage_id: z.string().min(1),
  pipeline_name: z.string().nullable().default(null),
  stage_name: z.string().nullable().default(null),
});

export const pipelineStageMapSchema = z.array(pipelineStageMapEntrySchema);

export const agentSchema = z.object({
  name: z.string().min(1),
  direction: z.enum(["inbound", "outbound"]).default("outbound"),
  enroll_tag: z.string().nullable().default(null),
  retell_agent_id: z.string().nullable().default(null),
  retell_from_number: z.string().nullable().default(null),
  objective: z.string().nullable().default(null),
  // Per-agent CRM. Optional here so the workspace-provisioning path (where
  // CRM lives on the workspace) keeps validating; required in createAgentSchema.
  crm_provider: z.enum(["followupboss", "highlevel"]).nullable().default(null),
  crm_credentials: crmCredentialsSchema.nullable().default(null),
  // Per-agent Retell creds (inbound agents only).
  retell_credentials: retellCredentialsSchema.nullable().default(null),
  callConfig: callConfigSchema,
  taskConfig: taskConfigSchema,
});

/**
 * Payload for adding an agent to an existing workspace. CRM can be supplied
 * per-agent or inherited from the workspace (`inherit_workspace_crm`).
 * Direction-specific rules:
 *   - outbound → enroll tag required (drives enrollment + cadence).
 *   - inbound  → Retell agent id + Retell credentials required.
 */
export const createAgentSchema = agentSchema
  .extend({
    inherit_workspace_crm: z.boolean().default(false),
  })
  .superRefine((val, ctx) => {
  const inheritsCrm =
    val.inherit_workspace_crm ||
    (!val.crm_provider && !val.crm_credentials);

  if (inheritsCrm) {
    if (val.crm_provider || val.crm_credentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inherit_workspace_crm"],
        message:
          "Use either workspace CRM inheritance or per-agent credentials, not both.",
      });
    }
  } else {
    if (!val.crm_provider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crm_provider"],
        message: "Choose a CRM (Follow Up Boss or HighLevel), or inherit the workspace connection.",
      });
    }
    if (!val.crm_credentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crm_credentials"],
        message: "CRM credentials are required unless inheriting the workspace connection.",
      });
    } else if (
      val.crm_provider === "followupboss" &&
      !("apiKey" in val.crm_credentials)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crm_credentials"],
        message: "Follow Up Boss needs an API key.",
      });
    } else if (
      val.crm_provider === "highlevel" &&
      !("accessToken" in val.crm_credentials)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crm_credentials"],
        message: "HighLevel needs an access token and location id.",
      });
    }
  }

  if (val.direction === "outbound") {
    if (!val.enroll_tag || val.enroll_tag.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enroll_tag"],
        message: "Outbound agents need an enrollment tag.",
      });
    }
  } else {
    // inbound
    if (!val.retell_agent_id || val.retell_agent_id.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retell_agent_id"],
        message: "Inbound agents need their Retell agent ID.",
      });
    }
    if (!val.retell_credentials) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retell_credentials"],
        message: "Inbound agents need Retell credentials.",
      });
    }
  }
});

export const provisionWorkspaceSchema = z.object({
  organizationName: z.string().min(1).optional(),
  organizationId: z.string().uuid().optional(),
  workspace: z.object({
    name: z.string().min(1),
    timezone: z.string().default("America/New_York"),
    crm_provider: z.enum(["followupboss", "highlevel"]),
    enroll_tag: z.string().default("upsurgecallflowai"),
    crm_account_url: crmAccountUrlSchema.default(null),
    credentials: crmCredentialsSchema,
  }),
  agents: z.array(agentSchema).min(1),
});

export type ProvisionWorkspaceInput = z.infer<typeof provisionWorkspaceSchema>;
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

/** Payload for POST /api/agents/:id/duplicate — outbound needs a unique enroll tag. */
export const duplicateAgentSchema = z.object({
  name: z.string().trim().min(1, "Agent name is required."),
  enroll_tag: z.string().nullable().default(null),
});

export type DuplicateAgentInput = z.infer<typeof duplicateAgentSchema>;

export const runWorkspacePollSchema = z.object({
  testMode: z.boolean().default(false),
});

/**
 * Payload for the bulk "Queue calls now" Ops action: enqueue a hand-picked set
 * of enrolled contacts into the live call queue immediately, drip-spaced.
 */
export const queueCallsSchema = z.object({
  agentId: z.string().uuid(),
  contactIds: z.array(z.string().uuid()).min(1).max(1000),
});

/**
 * Payload for the manual test-call trigger. A chosen outbound agent either:
 *   - dials an existing enrolled contact now (contactId) via the call queue, or
 *   - dials an arbitrary number now (toNumber) inline, with no contact/queue.
 * Exactly one of contactId / toNumber must be provided.
 */
export const testCallSchema = z
  .object({
    agentId: z.string().uuid(),
    contactId: z.string().uuid().optional(),
    toNumber: z
      .string()
      .trim()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        "Enter a phone number in E.164 format, e.g. +15551234567"
      )
      .optional(),
  })
  .refine((v) => Boolean(v.contactId) !== Boolean(v.toNumber), {
    message: "Provide either a contact or a phone number, not both.",
  });
