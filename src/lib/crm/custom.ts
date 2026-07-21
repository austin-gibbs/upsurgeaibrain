// =====================================================================
// Custom integration adapter (e.g. SellMyFISBO).
//
// Unlike Follow Up Boss / HighLevel, the EXTERNAL app is the system of record.
// UpSurge is invoked on-demand (a "trigger call" API hit), places ONE outbound
// Retell call, then POSTs a post-call report back to the app. There is no CRM to
// poll, no tags to reconcile, no timeline to write.
//
// Design goals (must not interfere with FUB/HL):
//   - getContactsByTag() returns [] so the poller never enrolls these contacts.
//   - getContactFieldValues() surfaces per-lead + per-agent dynamic variables
//     (homeowner_name, agent_name, …) from contacts.dynamic_var_overrides, which
//     caller.ts already injects into the Retell prompt. ZERO caller.ts changes.
//   - Write methods (setTags/addNote/logCall/createTask) are safe no-ops; the
//     external app owns all lead state and gets the outcome via the report hook.
// =====================================================================
import { createServiceClient } from "@/lib/supabase/server";
import type {
  CreateTaskInput,
  CrmAdapter,
  CrmContact,
  CrmUser,
  CustomCredentials,
  LogCallInput,
  LogCallResult,
} from "./types";

export class CustomAdapter implements CrmAdapter {
  readonly provider = "custom" as const;

  constructor(
    private readonly creds: CustomCredentials,
    private readonly ctx: { workspaceId: string }
  ) {}

  /** Poller-facing: this integration is on-demand, so it never enrolls by tag. */
  async getContactsByTag(): Promise<CrmContact[]> {
    return [];
  }

  /**
   * Return the locally-stored contact so caller.ts can resolve name/phones.
   * The external app already created this row via the trigger endpoint.
   */
  async getContact(contactId: string): Promise<CrmContact | null> {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("contacts")
      .select("crm_contact_id, full_name, email, phones, tags")
      .eq("workspace_id", this.ctx.workspaceId)
      .eq("crm_contact_id", contactId)
      .maybeSingle();
    if (!data) return null;
    return {
      id: data.crm_contact_id,
      fullName: data.full_name ?? null,
      email: data.email ?? null,
      phones: Array.isArray(data.phones) ? data.phones : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
    };
  }

  /**
   * Per-lead + per-agent dynamic variables for the Retell prompt. caller.ts
   * merges these under the base variables ({{homeowner_name}}, {{agent_name}},
   * {{property_address}}, …). Pulled from the jsonb the trigger endpoint wrote.
   */
  async getContactFieldValues(contactId: string): Promise<Record<string, string>> {
    const supabase = createServiceClient();
    const { data } = await supabase
      .from("contacts")
      .select("dynamic_var_overrides")
      .eq("workspace_id", this.ctx.workspaceId)
      .eq("crm_contact_id", contactId)
      .maybeSingle();
    const overrides = data?.dynamic_var_overrides;
    if (!overrides || typeof overrides !== "object") return {};
    // Coerce every value to a string; drop null/undefined.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v);
    }
    return out;
  }

  // ----- Write paths: external app owns lead state, so these are no-ops. -----

  async setTags(): Promise<void> {
    /* no-op: external app owns tags */
  }

  async addNote(): Promise<void> {
    /* no-op: report is delivered via the post-call webhook instead */
  }

  async logCall(_input: LogCallInput): Promise<LogCallResult> {
    void _input;
    return { noteLogged: false, recordingCallLogged: false };
  }

  async createTask(_input: CreateTaskInput): Promise<void> {
    void _input;
    /* no-op: external app schedules its own follow-up */
  }

  /** No assignable users in an external-app integration. */
  async listUsers(): Promise<CrmUser[]> {
    return [];
  }

  /** Usable as long as a report webhook URL is configured. */
  async verifyCredentials(): Promise<boolean> {
    return typeof this.creds.reportWebhookUrl === "string" && this.creds.reportWebhookUrl.length > 0;
  }
}
