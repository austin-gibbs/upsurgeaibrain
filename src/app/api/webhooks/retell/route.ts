// =====================================================================
// POST /api/webhooks/retell
// Retell calls this on call_started / call_ended / call_analyzed.
// We verify the signature, then process call_analyzed events.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { listWebhookSecretCandidates, verifyRetellSignature } from "@/lib/retell/client";
import { perAgentWebhookSecretsFromBody } from "@/lib/retell/webhook-secrets";
import { processRetellWebhook } from "@/lib/engine/process-outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-retell-signature") ?? req.headers.get("X-Retell-Signature");

  const extraSecrets = await perAgentWebhookSecretsFromBody(rawBody);
  const candidates = listWebhookSecretCandidates(extraSecrets);

  if (candidates.length === 0) {
    console.error(
      "[retell webhook] 503 no webhook secrets configured — set RETELL_WEBHOOK_SECRET on Vercel " +
        "and/or per-agent webhookSecret; CREDENTIALS_ENCRYPTION_KEY must also be set on Vercel " +
        "to decrypt per-agent secrets"
    );
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }

  if (!verifyRetellSignature(rawBody, signature, extraSecrets)) {
    // Log (without exposing secrets) so a key mismatch is visible instead of
    // silently dropping outcomes. A burst of these means an agent's webhook
    // key is wrong — calls will stick in `dialing` until the sweep reconciles.
    let ctx = "";
    try {
      const parsed = JSON.parse(rawBody) as {
        event?: string;
        call?: { call_id?: string; agent_id?: string };
      };
      ctx = ` event=${parsed?.event ?? "?"} retell_call_id=${parsed?.call?.call_id ?? "?"} retell_agent_id=${parsed?.call?.agent_id ?? "?"} hadPerAgentSecret=${extraSecrets.length > 0} candidateSecrets=${candidates.length}`;
    } catch {
      /* body not JSON — nothing more to log */
    }
    console.error(`[retell webhook] 401 invalid signature.${ctx}`);
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  try {
    const result = await processRetellWebhook(body, { finalizedBy: "webhook" });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e: any) {
    console.error("[retell webhook] error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
