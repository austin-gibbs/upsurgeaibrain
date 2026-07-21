// =====================================================================
// End-to-end agent provisioning.
//
// One call stands up a brand-new voice agent: it AUTHORS the agent in Retell
// (LLM/flow + voice + post-call analysis + phone number), then WIRES it into
// the app (workspace + agents row + call config + task config) and, when
// asked, activates it — running the same activation invariants the UI uses.
//
// This is the automation entry point used by the Claude/Cowork provisioning
// flow (via the admin endpoint or the standalone script). It mirrors the
// behaviour of POST /api/workspaces and POST /api/workspaces/:id/agents but
// has NO user-session dependency: the caller supplies a service-role db client
// and a complete, validated spec.
// =====================================================================
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptJson } from "@/lib/crypto";
import { validateAgentActivation } from "@/lib/agents/activation";
import { bindRetellWebhookForAgentSafe, appRetellWebhookUrl } from "@/lib/retell/webhook-bind";
import {
  createRetellAgent,
  createRetellLlm,
  createRetellPhoneNumber,
  DEFAULT_POST_CALL_ANALYSIS_DATA,
  type RetellResponseEngine,
} from "@/lib/retell/authoring";
import {
  callConfigSchema,
  taskConfigSchema,
  pipelineStageMapSchema,
  crmCredentialsSchema,
  customCredentialsSchema,
  crmAccountUrlSchema,
} from "@/lib/validation";
import {
  effectiveEnrollTag,
  enrollTagConflict,
  enrollTagTakenMessage,
  type AgentEnrollTagRow,
} from "@/lib/agents/enroll-tag";

const E164 = /^\+[1-9]\d{7,14}$/;

const retellPhoneSchema = z.discriminatedUnion("mode", [
  // Buy a Retell-managed number, optionally in a preferred area code.
  z.object({ mode: z.literal("provision"), areaCode: z.number().int().optional() }),
  // Use a number that already exists in this client's Retell account.
  z.object({
    mode: z.literal("existing"),
    number: z.string().regex(E164, "Use E.164, e.g. +14706483981"),
  }),
  // No outbound number (inbound-only agents bound to a line you manage).
  z.object({ mode: z.literal("none") }),
]);

// Extra post-call analysis fields APPENDED to the always-present defaults
// (call_outcome + appointment_time). Used by the custom SellMyFISBO integration
// to surface report fields (seller_timeline, asking_price, etc.) back to the
// external app. Omit for FUB/HighLevel agents — they use the defaults.
const postCallFieldSchema = z.object({
  type: z.enum(["string", "enum", "boolean", "number"]).default("string"),
  name: z.string().min(1),
  description: z.string().default(""),
  choices: z.array(z.string()).optional(),
});

const responseEngineSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("retell-llm") }),
    z.object({
      type: z.literal("conversation-flow"),
      conversationFlowId: z.string().min(1),
    }),
  ])
  .default({ type: "retell-llm" });

const retellSpecSchema = z.object({
  apiKey: z.string().min(10),
  webhookSecret: z.string().optional(),
  voiceId: z.string().default("11labs-Adrian"),
  model: z.string().default("gpt-4o"),
  language: z.string().default("en-US"),
  responseEngine: responseEngineSchema,
  /** Required when responseEngine is a Retell LLM. */
  generalPrompt: z.string().optional(),
  beginMessage: z.string().optional(),
  /** Optional extra post-call analysis fields, appended to the defaults. */
  extraPostCallFields: z.array(postCallFieldSchema).optional(),
  phone: retellPhoneSchema,
});

const newWorkspaceSchema = z.object({
  mode: z.literal("new"),
  // Attach to an org by id, or find-or-create one by name (exactly one is
  // required — enforced in the top-level superRefine).
  organizationId: z.string().uuid().optional(),
  organizationName: z.string().min(1).optional(),
  name: z.string().min(1),
  timezone: z.string().default("America/New_York"),
  // The DB column crm_provider is NOT NULL, so a provider is always chosen.
  // Credentials, however, may be deferred (see crmCredentials below).
  // "custom" is the external-app integration (e.g. SellMyFISBO): its
  // credentials carry a report webhook URL, not a CRM API key.
  crmProvider: z.enum(["followupboss", "highlevel", "custom"]).default("followupboss"),
  enrollTag: z.string().default("upsurgecallflowai"),
  crmAccountUrl: crmAccountUrlSchema.default(null),
  // OPTIONAL. Omit to stand up the workspace WITHOUT a CRM connection yet — the
  // agent then lands as `draft` until CRM is connected in the app. Supply to
  // wire CRM at provision time (required for immediate activation). Accepts a
  // FUB/HighLevel credential OR a custom-integration report-webhook credential.
  crmCredentials: z.union([crmCredentialsSchema, customCredentialsSchema]).optional(),
});

const existingWorkspaceSchema = z.object({
  mode: z.literal("existing"),
  id: z.string().uuid(),
});

const workspaceSpecSchema = z.discriminatedUnion("mode", [
  newWorkspaceSchema,
  existingWorkspaceSchema,
]);

const agentSpecSchema = z.object({
  name: z.string().min(1),
  /** Outbound enrollment tag; null inherits the workspace tag. */
  enrollTag: z.string().nullable().default(null),
  objective: z.string().nullable().default(null),
  inheritWorkspaceCrm: z.boolean().default(true),
  crmProvider: z.enum(["followupboss", "highlevel"]).nullable().default(null),
  crmCredentials: crmCredentialsSchema.nullable().default(null),
  /** Optional; missing keys fall back to call-config defaults. */
  callConfig: callConfigSchema.optional(),
  taskConfig: taskConfigSchema.optional(),
  /**
   * Optional outcome -> HighLevel pipeline-stage routing rules. Each entry
   * pins (outcome, optional call_attempt) to a pipeline + stage. Requires the
   * effective CRM to be HighLevel and `taskConfig.pipeline_automation_enabled`
   * for after-call moves to fire. Pipeline/stage IDs come from the client's
   * HighLevel account (fetch via GET /api/console/highlevel).
   */
  pipelineStageMap: pipelineStageMapSchema.optional(),
});

export const provisionRetellAgentSchema = z
  .object({
    direction: z.enum(["inbound", "outbound"]),
    retell: retellSpecSchema,
    workspace: workspaceSpecSchema,
    agent: agentSpecSchema,
    /**
     * App login email of the person who should OWN this workspace. Required so
     * the workspace is visible in the app: RLS scopes visibility by org
     * membership (organization_members), so without an owner the workspace is
     * created but invisible to every UI user. Used to set created_by + add an
     * owner membership row when a new org is created.
     */
    ownerEmail: z.string().email().optional(),
    /** Flip the agent to "active" after wiring (subject to activation rules). */
    activate: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    if (
      val.retell.responseEngine.type === "retell-llm" &&
      !val.retell.generalPrompt?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retell", "generalPrompt"],
        message: "A general prompt is required for a Retell LLM agent.",
      });
    }
    if (val.direction === "outbound" && val.retell.phone.mode === "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retell", "phone"],
        message:
          "Outbound agents need a from-number — set phone.mode to provision or existing.",
      });
    }
    if (
      val.workspace.mode === "new" &&
      !val.workspace.organizationId &&
      !val.workspace.organizationName
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspace", "organizationId"],
        message:
          "A new workspace needs an organizationId or organizationName.",
      });
    }
  });

export type ProvisionRetellAgentInput = z.input<typeof provisionRetellAgentSchema>;

export interface ProvisionResult {
  retellLlmId: string | null;
  retellAgentId: string;
  fromNumber: string | null;
  organizationId: string | null;
  workspaceId: string;
  agentId: string;
  status: "active" | "draft";
  /** Set when activate was requested but blocked by an activation rule. */
  activationBlockedReason: string | null;
}

type WorkspaceRow = {
  id: string;
  enroll_tag: string;
  crm_provider: "followupboss" | "highlevel" | "custom" | null;
  crm_credentials_encrypted: string | null;
};

/**
 * Author a Retell agent and wire it into the app. Throws on any failure;
 * Retell resources created before a later failure are reported in the error
 * message so they can be cleaned up manually (no automatic rollback).
 */
export async function provisionRetellAgent(
  db: SupabaseClient,
  specInput: ProvisionRetellAgentInput
): Promise<ProvisionResult> {
  const spec = provisionRetellAgentSchema.parse(specInput);
  const { retell } = spec;
  const webhookUrl = appRetellWebhookUrl();

  // Resolve the owner up front (before any Retell resource is created) so a bad
  // email fails fast without leaving orphans. The owner makes the workspace
  // visible in the app — see ownerEmail in the schema.
  let ownerUserId: string | null = null;
  if (spec.ownerEmail) {
    const { data: profile, error: profErr } = await db
      .from("profiles")
      .select("id")
      .eq("email", spec.ownerEmail)
      .maybeSingle<{ id: string }>();
    if (profErr) {
      throw new Error(`failed to look up owner profile: ${profErr.message}`);
    }
    if (!profile) {
      throw new Error(
        `No app user found with email "${spec.ownerEmail}". Sign in to the app once with that email first, or use an existing-org id you already belong to.`
      );
    }
    ownerUserId = profile.id;
  }

  // ---- 1. Author the Retell response engine -------------------------------
  let retellLlmId: string | null = null;
  let responseEngine: RetellResponseEngine;
  if (retell.responseEngine.type === "retell-llm") {
    const { llmId } = await createRetellLlm(retell.apiKey, {
      generalPrompt: retell.generalPrompt!.trim(),
      beginMessage: retell.beginMessage,
      model: retell.model,
    });
    retellLlmId = llmId;
    responseEngine = { type: "retell-llm", llmId };
  } else {
    responseEngine = {
      type: "conversation-flow",
      conversationFlowId: retell.responseEngine.conversationFlowId,
    };
  }

  // ---- 2. Create the agent ------------------------------------------------
  const { agentId: retellAgentId } = await createRetellAgent(retell.apiKey, {
    agentName: spec.agent.name,
    responseEngine,
    voiceId: retell.voiceId,
    language: retell.language,
    webhookUrl,
    ...(retell.extraPostCallFields && retell.extraPostCallFields.length > 0
      ? {
          postCallAnalysisData: [
            ...DEFAULT_POST_CALL_ANALYSIS_DATA,
            ...retell.extraPostCallFields,
          ],
        }
      : {}),
  });

  // ---- 3. Phone number ----------------------------------------------------
  let fromNumber: string | null = null;
  if (retell.phone.mode === "provision") {
    try {
      const { phoneNumber } = await createRetellPhoneNumber(retell.apiKey, {
        areaCode: retell.phone.areaCode,
        ...(spec.direction === "outbound"
          ? { outboundAgentId: retellAgentId }
          : { inboundAgentId: retellAgentId }),
        nickname: spec.agent.name,
      });
      fromNumber = phoneNumber;
    } catch (err) {
      // The Retell LLM + agent already exist; name them so they can be deleted
      // in Retell before retrying (no automatic rollback).
      const m = err instanceof Error ? err.message : String(err);
      const orphans = [
        `agent ${retellAgentId}`,
        retellLlmId ? `llm ${retellLlmId}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `${m}\nOrphaned Retell resources to delete before retrying: ${orphans}.`
      );
    }
  } else if (retell.phone.mode === "existing") {
    fromNumber = retell.phone.number;
  }

  // ---- 4. Resolve / create the workspace ----------------------------------
  let workspace: WorkspaceRow;
  let organizationId: string | null = null;
  if (spec.workspace.mode === "existing") {
    const { data, error } = await db
      .from("workspaces")
      .select("id, enroll_tag, crm_provider, crm_credentials_encrypted")
      .eq("id", spec.workspace.id)
      .single<WorkspaceRow>();
    if (error || !data) {
      throw new Error(
        `Workspace ${spec.workspace.id} not found (retell agent ${retellAgentId} was created).`
      );
    }
    workspace = data;
  } else {
    // Resolve the organization: use the supplied id, or find-or-create by name.
    let orgId = spec.workspace.organizationId ?? null;
    if (!orgId) {
      const orgName = spec.workspace.organizationName!.trim();
      const { data: existingOrg } = await db
        .from("organizations")
        .select("id")
        .eq("name", orgName)
        .limit(1)
        .maybeSingle<{ id: string }>();
      if (existingOrg) {
        orgId = existingOrg.id;
      } else {
        const { data: newOrg, error: orgErr } = await db
          .from("organizations")
          .insert({ name: orgName, created_by: ownerUserId })
          .select("id")
          .single<{ id: string }>();
        if (orgErr || !newOrg) {
          throw new Error(
            `failed to create organization "${orgName}": ${orgErr?.message} (retell agent ${retellAgentId} was created).`
          );
        }
        orgId = newOrg.id;
      }
    }

    // Ensure the owner is a member of the org — RLS scopes app visibility by
    // organization_members, so without this the workspace is invisible in the
    // UI. Idempotent upsert; safe whether the org was just created or matched.
    if (ownerUserId) {
      const { error: memErr } = await db
        .from("organization_members")
        .upsert(
          { organization_id: orgId, user_id: ownerUserId, role: "owner" },
          { onConflict: "organization_id,user_id" }
        );
      if (memErr) {
        throw new Error(
          `failed to add owner membership: ${memErr.message} (retell agent ${retellAgentId} was created).`
        );
      }
    }

    // CRM credentials are optional. When omitted, the workspace is created with
    // no connection (crm_credentials_encrypted = null) and the agent lands as
    // draft until CRM is connected in the app.
    let crmCredentialsEncrypted: string | null = null;
    if (spec.workspace.crmCredentials) {
      try {
        crmCredentialsEncrypted = encryptJson(spec.workspace.crmCredentials);
      } catch (err) {
        const m = err instanceof Error ? err.message : "encryption failed";
        throw new Error(`encryption misconfigured: ${m}`);
      }
    }
    const { data, error } = await db
      .from("workspaces")
      .insert({
        organization_id: orgId,
        name: spec.workspace.name,
        timezone: spec.workspace.timezone,
        crm_provider: spec.workspace.crmProvider,
        crm_credentials_encrypted: crmCredentialsEncrypted,
        enroll_tag: spec.workspace.enrollTag,
        crm_account_url: spec.workspace.crmAccountUrl ?? null,
        created_by: ownerUserId,
      })
      .select("id, enroll_tag, crm_provider, crm_credentials_encrypted")
      .single<WorkspaceRow>();
    if (error || !data) {
      throw new Error(
        `failed to create workspace: ${error?.message} (retell agent ${retellAgentId} was created).`
      );
    }
    workspace = data;
    organizationId = orgId;

    const { error: seedErr } = await db.rpc("seed_default_outcome_tags", {
      p_workspace_id: workspace.id,
    });
    if (seedErr) {
      throw new Error(`failed to seed outcome tags: ${seedErr.message}`);
    }
  }

  // ---- 5. Resolve agent CRM (inherit vs per-agent) ------------------------
  const inheritsCrm =
    spec.agent.inheritWorkspaceCrm ||
    (!spec.agent.crmProvider && !spec.agent.crmCredentials);
  let agentCrmProvider: "followupboss" | "highlevel" | null = null;
  let agentCrmEncrypted: string | null = null;
  if (!inheritsCrm) {
    agentCrmProvider = spec.agent.crmProvider;
    agentCrmEncrypted = spec.agent.crmCredentials
      ? encryptJson(spec.agent.crmCredentials)
      : null;
  }
  // A missing CRM connection is intentionally NOT fatal: when the workspace
  // (or agent) has no CRM creds yet, the activation invariant below leaves the
  // agent as `draft` with a clear reason. This supports the "provision now,
  // connect CRM later" flow — activation simply won't flip it to active until
  // CRM is wired in the app.

  // ---- 6. Enroll-tag uniqueness (outbound) --------------------------------
  const enrollTag = spec.direction === "outbound" ? spec.agent.enrollTag : null;
  const { data: existingAgents } = await db
    .from("agents")
    .select("id, direction, enroll_tag")
    .eq("workspace_id", workspace.id)
    .returns<AgentEnrollTagRow[]>();
  if (spec.direction === "outbound" && enrollTag) {
    if (
      enrollTagConflict(enrollTag, workspace.enroll_tag, existingAgents ?? [])
    ) {
      throw new Error(
        enrollTagTakenMessage(effectiveEnrollTag(enrollTag, workspace.enroll_tag))
      );
    }
  }

  // ---- 7. Insert agent (draft first) + configs ----------------------------
  const retellCredentialsEncrypted = encryptJson({
    apiKey: retell.apiKey,
    ...(retell.webhookSecret ? { webhookSecret: retell.webhookSecret } : {}),
  });

  const { data: agent, error: agErr } = await db
    .from("agents")
    .insert({
      workspace_id: workspace.id,
      name: spec.agent.name,
      direction: spec.direction,
      enroll_tag: enrollTag,
      retell_agent_id: retellAgentId,
      retell_from_number: fromNumber,
      objective: spec.agent.objective,
      crm_provider: agentCrmProvider,
      crm_credentials_encrypted: agentCrmEncrypted,
      retell_credentials_encrypted: retellCredentialsEncrypted,
      status: "draft",
    })
    .select("id")
    .single<{ id: string }>();
  if (agErr || !agent) {
    throw new Error(`failed to create agent: ${agErr?.message}`);
  }

  const callConfig = spec.agent.callConfig ?? callConfigSchema.parse({});
  const taskConfig = spec.agent.taskConfig ?? taskConfigSchema.parse({});

  const { error: ccErr } = await db
    .from("agent_call_configs")
    .insert({ agent_id: agent.id, ...callConfig });
  if (ccErr) {
    throw new Error(`failed to create agent call config: ${ccErr.message}`);
  }
  const { error: tcErr } = await db
    .from("agent_task_configs")
    .insert({ agent_id: agent.id, ...taskConfig });
  if (tcErr) {
    throw new Error(`failed to create agent task config: ${tcErr.message}`);
  }

  // Optional outcome -> pipeline stage routing rules (HighLevel). Insert the
  // supplied rules so after-call pipeline automation has a map to consult;
  // without these, pipeline_automation_enabled is a no-op. Mirrors the
  // replace-all semantics of PATCH /api/agents/[id].
  if (spec.agent.pipelineStageMap && spec.agent.pipelineStageMap.length > 0) {
    const stageRows = spec.agent.pipelineStageMap.map((entry) => ({
      agent_id: agent.id,
      outcome: entry.outcome,
      call_attempt: entry.call_attempt,
      pipeline_id: entry.pipeline_id,
      pipeline_stage_id: entry.pipeline_stage_id,
      pipeline_name: entry.pipeline_name,
      stage_name: entry.stage_name,
      updated_at: new Date().toISOString(),
    }));
    const { error: smErr } = await db
      .from("agent_pipeline_stage_map")
      .insert(stageRows);
    if (smErr) {
      throw new Error(`failed to create pipeline stage map: ${smErr.message}`);
    }
  }

  // ---- 8. Bind webhook events on the agent (defensive) --------------------
  await bindRetellWebhookForAgentSafe({
    id: agent.id,
    retell_agent_id: retellAgentId,
    retell_credentials_encrypted: retellCredentialsEncrypted,
  });

  // ---- 9. Activate (running the same invariants as the UI) ----------------
  let status: "active" | "draft" = "draft";
  let activationBlockedReason: string | null = null;
  if (spec.activate) {
    activationBlockedReason = validateAgentActivation({
      agentId: agent.id,
      direction: spec.direction,
      enrollTag,
      retellAgentId,
      retellFromNumber: fromNumber,
      retellCredentialsEncrypted,
      workspaceEnrollTag: workspace.enroll_tag,
      existingAgents: existingAgents ?? [],
      agent: {
        crm_provider: agentCrmProvider,
        crm_credentials_encrypted: agentCrmEncrypted,
      },
      workspace: {
        crm_provider: workspace.crm_provider,
        crm_credentials_encrypted: workspace.crm_credentials_encrypted,
      },
      hasCallConfig: true,
    });
    if (!activationBlockedReason) {
      const { error: upErr } = await db
        .from("agents")
        .update({ status: "active" })
        .eq("id", agent.id);
      if (upErr) {
        throw new Error(`failed to activate agent: ${upErr.message}`);
      }
      status = "active";
    }
  }

  return {
    retellLlmId,
    retellAgentId,
    fromNumber,
    organizationId,
    workspaceId: workspace.id,
    agentId: agent.id,
    status,
    activationBlockedReason,
  };
}
