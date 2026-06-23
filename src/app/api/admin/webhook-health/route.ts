// =====================================================================
// GET /api/admin/webhook-health
//
// Read-only config + timing health check for the Retell webhook path.
// Auth: Bearer CRON_SECRET (same as reconcile-stuck-calls).
// Never returns secret values — only presence/absence and recent metrics.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { decryptJson } from "@/lib/crypto";
import {
  getRetellWebhookSecretForAgent,
  listWebhookSecretCandidates,
  type RetellCredentials,
} from "@/lib/retell/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  const { data: recentTiming } = await supabase
    .from("calls")
    .select("contact_name, dialed_at, completed_at")
    .not("dialed_at", "is", null)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(5);

  const timingSamples = (recentTiming ?? []).map((c) => {
    const gapSec = Math.round(
      (new Date(c.completed_at!).getTime() - new Date(c.dialed_at!).getTime()) / 1000
    );
    return {
      contact: c.contact_name,
      dialToCompleteSeconds: gapSec,
      likelyPath: gapSec < 120 ? "webhook" : "reconcile",
    };
  });

  const reconcileShare =
    completedLastHour && reconcileLastHour != null
      ? reconcileLastHour / completedLastHour
      : null;

  const healthy =
    webhookConfigured &&
    encryptionKey &&
    (reconcileShare == null || reconcileShare < 0.1) &&
    (stuckDialing ?? 0) === 0;

  return NextResponse.json({
    healthy,
    config: {
      envWebhookSecret,
      credentialsEncryptionKey: encryptionKey,
      webhookConfigured,
      candidateSecretCount: candidateSecrets.length,
      agents: agentSecrets,
      requiredOnVercel: [
        "RETELL_WEBHOOK_SECRET (must match Retell dashboard signing key)",
        "CREDENTIALS_ENCRYPTION_KEY (must match worker/Railway for per-agent secret decrypt)",
      ],
    },
    metrics: {
      completedLastHour: completedLastHour ?? 0,
      finalizedViaWebhookLastHour: webhookLastHour ?? 0,
      finalizedViaReconcileLastHour: reconcileLastHour ?? 0,
      reconcileShareLastHour: reconcileShare,
      stuckDialing: stuckDialing ?? 0,
      recentTiming: timingSamples,
    },
  });
}
