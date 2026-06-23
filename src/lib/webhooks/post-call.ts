// =====================================================================
// Post-call webhook dispatcher — sends call outcome JSON to a configured
// URL (typically a HighLevel Workflow Inbound Webhook trigger).
// =====================================================================
import { decryptJson } from "@/lib/crypto";
import { outcomeLabel } from "@/lib/engine/outcome";
import type { HighLevelCredentials } from "@/lib/crm/types";
import type {
  Agent,
  Call,
  CallOutcome,
  Contact,
  Workspace,
} from "@/types";

export type PostCallWebhookPayload = {
  event: "call_completed";
  workspace_id: string;
  agent_id: string;
  agent_name: string;
  call_id: string;
  retell_call_id: string | null;
  attempt_number: number;
  outcome: CallOutcome;
  outcome_label: string;
  contact: {
    crm_contact_id: string;
    name: string | null;
    email: string | null;
    phone: string;
    tags: string[];
  };
  location_id: string | null;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  applied_tag: string | null;
  call_date: string;
  duration_seconds: number;
};

function hlLocationId(workspace: Workspace): string | null {
  if (workspace.crm_provider !== "highlevel" || !workspace.crm_credentials_encrypted) {
    return null;
  }
  try {
    const creds = decryptJson<HighLevelCredentials>(workspace.crm_credentials_encrypted);
    return creds.locationId ?? null;
  } catch {
    return null;
  }
}

export async function dispatchPostCallWebhook(opts: {
  webhookUrl: string;
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
  };
  appliedTag: string | null;
  callDate: string;
}): Promise<void> {
  const payload: PostCallWebhookPayload = {
    event: "call_completed",
    workspace_id: opts.workspace.id,
    agent_id: opts.agent.id,
    agent_name: opts.agent.name,
    call_id: opts.call.id,
    retell_call_id: opts.call.retell_call_id,
    attempt_number: opts.call.attempt_number,
    outcome: opts.outcome,
    outcome_label: outcomeLabel(opts.outcome),
    contact: {
      crm_contact_id: opts.contact.crm_contact_id,
      name: opts.contact.full_name,
      email: opts.contact.email,
      phone: opts.call.to_number,
      tags: opts.contact.tags,
    },
    location_id: hlLocationId(opts.workspace),
    summary: opts.parsed.summary,
    transcript: opts.parsed.transcript,
    recording_url: opts.parsed.recordingUrl,
    applied_tag: opts.appliedTag,
    call_date: opts.callDate,
    duration_seconds: opts.parsed.durationSeconds,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `[post-call webhook] ${opts.webhookUrl} -> ${res.status}`,
        await res.text().catch(() => "")
      );
    }
  } catch (err) {
    console.error("[post-call webhook] delivery failed:", err);
  } finally {
    clearTimeout(timeout);
  }
}
