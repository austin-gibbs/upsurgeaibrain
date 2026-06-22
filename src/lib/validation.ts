// Zod schemas for the workspace setup wizard payload.
import { z } from "zod";

export const crmCredentialsSchema = z.union([
  z.object({ apiKey: z.string().min(10) }), // FUB
  z.object({ accessToken: z.string().min(10), locationId: z.string().min(1) }), // HighLevel
]);

// Matches the call_outcome enum in the database so task-config outcome
// filters are typed correctly when inserted.
export const callOutcomeSchema = z.enum([
  "voicemail",
  "no_answer",
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
  call_window_start: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  call_window_end: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  daily_run_at: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  drip_seconds: z.number().int().min(1).default(60),
  cadence_day_gaps: z.array(z.number().int().min(0)).default([0, 1, 2, 3, 5, 7, 10, 14, 21, 30]),
});

export const taskConfigSchema = z.object({
  enabled: z.boolean().default(false),
  name_template: z.string().default("UpSurge AI Call Review for {contact_name} on {date}"),
  task_type: z.string().default("Follow Up"),
  assignee_crm_id: z.string().nullable().default(null),
  assignee_label: z.string().nullable().default(null),
  due_offset_minutes: z.number().int().default(0),
  only_outcomes: z.array(callOutcomeSchema).nullable().default(null),
});

export const agentSchema = z.object({
  name: z.string().min(1),
  retell_agent_id: z.string().nullable().default(null),
  retell_from_number: z.string().nullable().default(null),
  objective: z.string().nullable().default(null),
  callConfig: callConfigSchema,
  taskConfig: taskConfigSchema,
});

export const provisionWorkspaceSchema = z.object({
  organizationName: z.string().min(1).optional(),
  organizationId: z.string().uuid().optional(),
  workspace: z.object({
    name: z.string().min(1),
    timezone: z.string().default("America/New_York"),
    crm_provider: z.enum(["followupboss", "highlevel"]),
    enroll_tag: z.string().default("upsurgecallflowai"),
    credentials: crmCredentialsSchema,
  }),
  agents: z.array(agentSchema).min(1),
});

export type ProvisionWorkspaceInput = z.infer<typeof provisionWorkspaceSchema>;
