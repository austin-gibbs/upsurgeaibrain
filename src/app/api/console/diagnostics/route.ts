// =====================================================================
// GET /api/console/diagnostics — session+admin gated ops health snapshot.
// Proxies webhook health, engine/redis health, and stuck-call counts for the
// in-app admin console (no CRON_SECRET required in the browser).
// =====================================================================
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { probeRedisQueueHealth } from "@/lib/queue/redis-health";
import { decryptJson } from "@/lib/crypto";
import {
  getRetellWebhookSecretForAgent,
  listWebhookSecretCandidates,
  type RetellCredentials,
} from "@/lib/retell/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const supabase = createServiceClient();
  const envWebhookSecret = Boolean(process.env.RETELL_WEBHOOK_SECRET?.trim());
  const encryptionKey = Boolean(process.env.CREDENTIALS_ENCRYPTION_KEY?.trim());

  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, retell_agent_id, retell_credentials_encrypted")
    .not("retell_agent_id", "is", null);

  const perAgentSecrets: string[] = [];
  const agentSecrets = (agents ?? []).map((a) => {
    let decryptOk = false;
    let hasWebhookSecret = false;
    if (a.retell_credentials_encrypted) {
      try {
        decryptJson<RetellCredentials>(a.retell_credentials_encrypted);
        decryptOk = true;
        const secret = getRetellWebhookSecretForAgent({
          retell_credentials_encrypted: a.retell_credentials_encrypted,
        });
        hasWebhookSecret = Boolean(secret);
        if (secret) perAgentSecrets.push(secret);
      } catch {
        decryptOk = false;
      }
    }
    return {
      name: a.name,
      retellAgentId: a.retell_agent_id,
      hasRetellCreds: Boolean(a.retell_credentials_encrypted),
      decryptOk,
      hasWebhookSecret,
    };
  });

  const candidateSecrets = listWebhookSecretCandidates(perAgentSecrets);
  const webhookConfigured = candidateSecrets.length > 0;

  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count: completedLastHour } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed")
    .gte("completed_at", oneHourAgo);

  const { count: reconcileLastHour } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed")
    .eq("finalized_by", "reconcile")
    .gte("completed_at", oneHourAgo);

  const { count: webhookLastHour } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed")
    .eq("finalized_by", "webhook")
    .gte("completed_at", oneHourAgo);

  const { count: stuckDialing } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "dialing");

  const { count: completedWithoutPayload } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "completed")
    .is("raw_payload", null);

  const reconcileShare =
    completedLastHour && reconcileLastHour != null
      ? reconcileLastHour / completedLastHour
      : null;

  const redis = await probeRedisQueueHealth({ closeAfter: true });

  const healthy =
    webhookConfigured &&
    encryptionKey &&
    redis.ok &&
    (reconcileShare == null || reconcileShare < 0.1) &&
    (stuckDialing ?? 0) === 0;

  return NextResponse.json({
    healthy,
    webhook: {
      envWebhookSecret,
      credentialsEncryptionKey: encryptionKey,
      webhookConfigured,
      candidateSecretCount: candidateSecrets.length,
      agents: agentSecrets,
    },
    engine: {
      ok: redis.ok,
      redis: redis.ok ? "up" : "down",
      reason: redis.reason,
    },
    reporting: {
      completedLastHour: completedLastHour ?? 0,
      finalizedViaWebhookLastHour: webhookLastHour ?? 0,
      finalizedViaReconcileLastHour: reconcileLastHour ?? 0,
      reconcileShareLastHour: reconcileShare,
      stuckDialing: stuckDialing ?? 0,
      completedWithoutPayload: completedWithoutPayload ?? 0,
    },
  });
}
