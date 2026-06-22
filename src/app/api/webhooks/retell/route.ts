// =====================================================================
// POST /api/webhooks/retell
// Retell calls this on call_started / call_ended / call_analyzed.
// We verify the signature, then process call_analyzed events.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { verifyRetellSignature } from "@/lib/retell/client";
import { processRetellWebhook } from "@/lib/engine/process-outcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature =
    req.headers.get("x-retell-signature") ?? req.headers.get("X-Retell-Signature");

  if (!verifyRetellSignature(rawBody, signature)) {
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
