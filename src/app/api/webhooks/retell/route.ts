// =====================================================================
// POST /api/webhooks/retell
// Retell calls this on call_started / call_ended / call_analyzed.
// We verify the signature, then process call_analyzed events.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import {
  getRetellSignatureCandidatesForAgent,
  listWebhookSecretCandidates,
  verifyRetellSignature,
} from "@/lib/retell/client";
import { processRetellWebhook } from "@/lib/engine/process-outcome";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Resolve per-agent webhook secrets from the payload (Retell agent id or metadata). */
async function perAgentWebhookSecrets(rawBody: string): Promise<string[]> {
  try {
    const body = JSON.parse(rawBody) as {
      call?: { agent_id?: string; metadata?: { agent_id?: string } };
    };
    const retellAgentId = body?.call?.agent_id;
    const ourAgentId = body?.call?.metadata?.agent_id;
    const supabase = createServiceClient();
    const secrets: string[] = [];

    async function secretForAgentRow(
      row: { retell_credentials_encrypted: string | null } | null
    ): Promise<void> {
      if (!row) return;
      // Include the per-agent API key AND any dedicated webhook secret: Retell
      // signs with the API key, so it must be a candidate or every signature 401s.
      for (const secret of getRetellSignatureCandidatesForAgent(row)) {
        secrets.push(secret);
      }
    }

    if (retellAgentId) {
      const { data: agent } = await supabase
        .from("agents")
        .select("retell_credentials_encrypted")
        .eq("retell_agent_id", String(retellAgentId))
        .maybeSingle<{ retell_credentials_encrypted: string | null }>();
      await secretForAgentRow(agent);
    }

    // Fallback when Retell agent id lookup misses but metadata carries our id.
    if (!secrets.length && ourAgentId) {
      const { data: agent } = await supabase
        .from("agents")
        .select("retell_credentials_encrypted")
        .eq("id", String(ourAgentId))
        .maybeSingle<{ retell_credentials_encrypted: string | null }>();
      await secretForAgentRow(agent);
    }

    return secrets;
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-retell-signature") ?? req.headers.get("X-Retell-Signature");

  const extraSecrets = await perAgentWebhookSecrets(rawBody);
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
    // TEMP DIAGNOSTIC — store real signature + per-candidate digest comparison
    // to a debug table (Vercel CLI logs are unreliable). Removed after fix.
    try {
      const crypto = await import("crypto");
      const m = /v=(\d+),d=(.*)/.exec(signature ?? "");
      const parsed = JSON.parse(rawBody) as {
        event?: string;
        call?: { call_id?: string };
      };
      let tsDiff: number | null = null;
      let candidateResults: unknown = null;
      if (m) {
        const poststamp = Number(m[1]);
        const postDigest = m[2];
        tsDiff = Math.abs(Date.now() - poststamp);
        candidateResults = candidates.map((s, i) => ({
          idx: i,
          secretLen: s.length,
          plainMatch:
            crypto.createHmac("sha256", s).update(rawBody + poststamp).digest("hex") === postDigest,
          noTsMatch: crypto.createHmac("sha256", s).update(rawBody).digest("hex") === postDigest,
        }));
      }
      const supabase = createServiceClient() as any;
      await supabase.from("webhook_debug").insert({
        event: parsed?.event ?? null,
        retell_call_id: parsed?.call?.call_id ?? null,
        signature,
        raw_body: rawBody,
        ts_diff_ms: tsDiff,
        body_len: rawBody.length,
        candidate_results: candidateResults,
      });
    } catch {
      /* diagnostic only */
    }
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
