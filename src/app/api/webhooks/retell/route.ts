// =====================================================================
// POST /api/webhooks/retell
// Retell calls this on call_started / call_ended / call_analyzed.
// We verify the signature, then process call_analyzed events.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import {
  getRetellWebhookSecretForAgent,
  verifyRetellSignature,
} from "@/lib/retell/client";
import { processRetellWebhook } from "@/lib/engine/process-outcome";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Best-effort lookup of the per-agent webhook secret from the payload. */
async function perAgentWebhookSecrets(rawBody: string): Promise<string[]> {
  try {
    const body = JSON.parse(rawBody) as { call?: { agent_id?: string } };
    const retellAgentId = body?.call?.agent_id;
    if (!retellAgentId) return [];

    const supabase = createServiceClient();
    const { data: agent } = await supabase
      .from("agents")
      .select("retell_credentials_encrypted")
      .eq("retell_agent_id", String(retellAgentId))
      .maybeSingle<{ retell_credentials_encrypted: string | null }>();

    if (!agent) return [];
    const secret = getRetellWebhookSecretForAgent(agent);
    return secret ? [secret] : [];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-retell-signature") ?? req.headers.get("X-Retell-Signature");

  const extraSecrets = await perAgentWebhookSecrets(rawBody);
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
      ctx = ` event=${parsed?.event ?? "?"} retell_call_id=${parsed?.call?.call_id ?? "?"} retell_agent_id=${parsed?.call?.agent_id ?? "?"} hadPerAgentSecret=${extraSecrets.length > 0}`;
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
    const result = await processRetellWebhook(body);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e: any) {
    console.error("[retell webhook] error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
