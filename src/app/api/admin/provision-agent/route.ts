// =====================================================================
// POST /api/admin/provision-agent
//
// Headless, end-to-end agent provisioning for the Claude/Cowork flow.
// Authors the Retell agent (LLM/flow + voice + post-call analysis + phone),
// wires it into the app (workspace + agent + call/task config), and activates
// it — all with NO user session.
//
// Auth: Bearer PROVISION_API_KEY (a dedicated admin secret, distinct from
// CRON_SECRET). Uses the service-role client for writes, so the caller is
// fully trusted by virtue of holding the secret.
//
// Body: the provisionRetellAgentSchema spec (includes the client's Retell
// API key). Returns the created Retell + app identifiers.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { bearerMatches } from "@/lib/secure";
import { provisionRetellAgent } from "@/lib/provisioning/provision-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return bearerMatches(
    req.headers.get("authorization"),
    process.env.PROVISION_API_KEY
  );
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  if (!json) {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const db = createServiceClient();
  try {
    const result = await provisionRetellAgent(db, json);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Zod validation errors carry an `issues` array; surface them for fast
    // iteration. Everything else is a provisioning failure (Retell/DB).
    if (e && typeof e === "object" && "issues" in e) {
      return NextResponse.json(
        { error: "invalid payload", issues: (e as { issues: unknown }).issues },
        { status: 400 }
      );
    }
    const message = e instanceof Error ? e.message : "provisioning failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
