// One-time Retell agent webhook binding (provisioning / activation).
import type { Agent } from "@/types";
import { getRetellClientForAgent } from "./client";

/** Public URL Retell should POST call events to. */
export function appRetellWebhookUrl(): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL || "").trim() || "https://upsurgeprosai.com";
  return `${base.replace(/\/+$/, "")}/api/webhooks/retell`;
}

/**
 * Bind agent-level webhook delivery in Retell. Idempotent — call once at
 * provisioning or activation, not on every dial. Per-call webhook_url on
 * createPhoneCall remains the primary delivery path for override_agent_id.
 */
export async function bindRetellWebhookForAgent(
  agent: Pick<Agent, "retell_agent_id" | "retell_credentials_encrypted">
): Promise<void> {
  if (!agent.retell_agent_id?.trim()) return;
  const webhookUrl = appRetellWebhookUrl();
  const retell = getRetellClientForAgent(agent);
  await retell.ensureAgentWebhookUrl(agent.retell_agent_id, webhookUrl);
}

/** Non-fatal wrapper for activation flows. */
export async function bindRetellWebhookForAgentSafe(
  agent: Pick<Agent, "id" | "retell_agent_id" | "retell_credentials_encrypted">
): Promise<void> {
  try {
    await bindRetellWebhookForAgent(agent);
  } catch (err) {
    console.warn(
      `[retell] bindRetellWebhookForAgent failed for agent ${agent.id}: ${
        err instanceof Error ? err.message : err
      }`
    );
  }
}
