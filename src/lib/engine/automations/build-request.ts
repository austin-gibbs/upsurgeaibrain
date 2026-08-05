// =====================================================================
// Turning a trigger + a call context into the request we actually send.
//
// Split out of evaluate.ts so the admin console's "Test Push" can build the
// byte-for-byte same body from a sample context without pulling in Supabase or
// the BullMQ queue — a test push that renders its own payload would stop
// matching production the first time either side changed.
// =====================================================================
import { renderTemplate, renderPayload, type RenderScope } from "./render";
import type {
  AutomationActionConfig,
  AutomationEvalContext,
  AutomationTrigger,
} from "./types";

/** The only parts of a trigger the request depends on (so drafts work too). */
export type RequestTrigger = Pick<AutomationTrigger, "name" | "action_type" | "action_config">;

export type ResolvedLink = { type: string | null; url: string | null; label: string | null };

export function firstNameOf(fullName: string | null): string | null {
  if (!fullName) return null;
  const t = fullName.trim();
  return t ? t.split(/\s+/)[0] : null;
}

/** Resolve which link_type this trigger wants, from config or the call fields. */
export function resolveLinkType(
  cfg: AutomationActionConfig,
  ctx: AutomationEvalContext
): string | null {
  if (cfg.static_link_type) return cfg.static_link_type;
  if (cfg.link_type_field) {
    const v = ctx.customFields?.[cfg.link_type_field];
    if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
  }
  return null;
}

export function buildRequest(
  trigger: RequestTrigger,
  ctx: AutomationEvalContext,
  link: ResolvedLink
): { url: string | null; payload: Record<string, unknown> } {
  const cfg = trigger.action_config ?? {};
  const scope: RenderScope = { ctx, link };

  if (trigger.action_type === "internal_notify") {
    return {
      url: null,
      payload: {
        event: "automation_internal_notify",
        trigger: trigger.name,
        message: cfg.message_template ? renderTemplate(cfg.message_template, scope) : null,
        outcome: ctx.outcome,
        contact: ctx.contact,
      },
    };
  }

  // webhook / highlevel_sms: default payload matches the existing post-call
  // webhook shape so a HighLevel Inbound Webhook can map fields the same way,
  // plus the resolved message + link the automation is meant to deliver.
  const defaultPayload: Record<string, unknown> = {
    event: "post_call_automation",
    trigger_name: trigger.name,
    outcome: ctx.outcome,
    contact: {
      name: ctx.contact.full_name,
      first_name: ctx.contact.first_name,
      email: ctx.contact.email,
      phone: ctx.contact.phone,
    },
    link_type: link.type,
    link_url: link.url,
    message: cfg.message_template ? renderTemplate(cfg.message_template, scope) : null,
    summary: ctx.summary,
    custom_analysis_data: ctx.customFields,
  };

  const payload = cfg.payload_template
    ? renderPayload(cfg.payload_template, scope)
    : defaultPayload;

  return { url: cfg.url ?? null, payload };
}
