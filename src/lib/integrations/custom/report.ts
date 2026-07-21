// =====================================================================
// Custom-integration post-call report.
//
// After a custom-integration call (e.g. SellMyFISBO) is fully processed, POST a
// structured report back to the external app's `reportWebhookUrl` (stored in the
// workspace's encrypted CustomCredentials). The report carries the outcome plus
// the agent-defined Retell analysis fields (appointment_time, seller_timeline,
// asking_price, reason_for_selling, best_callback_time, …) and echoes the lead +
// triggering real-estate agent so the app can update the right record.
//
// Delivery is best-effort and must never block cadence/finalization. When a
// `reportWebhookSecret` is set, the body is signed as HMAC-SHA256 hex in the
// `X-UpSurge-Signature` header so the app can verify authenticity.
// =====================================================================
import crypto from "node:crypto";
import { decryptJson } from "@/lib/crypto";
import { outcomeLabel } from "@/lib/engine/outcome";
import type { CustomCredentials } from "@/lib/crm/types";
import type { Agent, Call, CallOutcome, Contact, Workspace } from "@/types";

export type CustomReportPayload = {
  event: "call_completed";
  workspace_id: string;
  agent_id: string;
  agent_name: string;
  call_id: string;
  retell_call_id: string | null;
  attempt_number: number;
  outcome: CallOutcome;
  outcome_label: string;
  /** External app's lead id (contacts.crm_contact_id). */
  lead_id: string;
  /** The dynamic variables that were injected into the call (lead + agent). */
  variables: Record<string, string>;
  /** Agent-defined Retell post-call fields (appointment_time, asking_price, …). */
  fields: Record<string, unknown>;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  call_date: string;
  duration_seconds: number;
};

/** Read + decrypt the workspace's CustomCredentials, or null if unusable. */
function customCredsForWorkspace(workspace: Workspace): CustomCredentials | null {
  if (workspace.crm_provider !== "custom" || !workspace.crm_credentials_encrypted) {
    return null;
  }
  try {
    const creds = decryptJson<CustomCredentials>(workspace.crm_credentials_encrypted);
    if (!creds?.reportWebhookUrl) return null;
    return creds;
  } catch {
    return null;
  }
}

export async function dispatchCustomReport(opts: {
  workspace: Workspace;
  agent: Agent;
  contact: Contact;
  call: Call;
  outcome: CallOutcome;
  parsed: {
    summary: string | null;
    transcript: string | null;
    recordingUrl: string | null;
    durationSeconds: number;
    customFields: Record<string, unknown>;
  };
  callDate: string;
}): Promise<void> {
  const creds = customCredsForWorkspace(opts.workspace);
  if (!creds) return;

  const variables: Record<string, string> = {};
  const overrides = opts.contact.dynamic_var_overrides;
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null || v === undefined) continue;
      variables[k] = String(v);
    }
  }

  const payload: CustomReportPayload = {
    event: "call_completed",
    workspace_id: opts.workspace.id,
    agent_id: opts.agent.id,
    agent_name: opts.agent.name,
    call_id: opts.call.id,
    retell_call_id: opts.call.retell_call_id,
    attempt_number: opts.call.attempt_number,
    outcome: opts.outcome,
    outcome_label: outcomeLabel(opts.outcome),
    lead_id: opts.contact.crm_contact_id,
    variables,
    fields: opts.parsed.customFields ?? {},
    summary: opts.parsed.summary,
    transcript: opts.parsed.transcript,
    recording_url: opts.parsed.recordingUrl,
    call_date: opts.callDate,
    duration_seconds: opts.parsed.durationSeconds,
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (creds.reportWebhookSecret) {
    headers["X-UpSurge-Signature"] = crypto
      .createHmac("sha256", creds.reportWebhookSecret)
      .update(body, "utf8")
      .digest("hex");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(creds.reportWebhookUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `[custom report] ${creds.reportWebhookUrl} -> ${res.status}`,
        await res.text().catch(() => "")
      );
    }
  } catch (err) {
    console.error("[custom report] delivery failed:", err);
  } finally {
    clearTimeout(timeout);
  }
}
