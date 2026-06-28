// =====================================================================
// POST /api/console/provision
//
// Session + admin gated wrapper around provisionRetellAgent so the whole
// "author Retell agent + wire into UpSurge + activate" flow can be driven from
// the in-app admin console (no terminal, no PROVISION_API_KEY). Same Zod spec
// and same activation invariants as the headless endpoint and the CLI script.
//
// Body: { spec: <provisionRetellAgentSchema>, dryRun?: boolean }.
//   dryRun: true validates the spec only (no Retell/DB writes).
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import {
  provisionRetellAgent,
  provisionRetellAgentSchema,
} from "@/lib/provisioning/provision-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const json = await req.json().catch(() => null);
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Accept either { spec, dryRun } or a bare spec for convenience.
  const dryRun = Boolean((json as { dryRun?: unknown }).dryRun);
  const spec = "spec" in json ? (json as { spec: unknown }).spec : json;

  const parsed = provisionRetellAgentSchema.safeParse(spec);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid spec", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      message: "Spec is valid. No Retell or database changes were made.",
    });
  }

  const db = createServiceClient();
  try {
    const result = await provisionRetellAgent(db, parsed.data);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e && typeof e === "object" && "issues" in e) {
      return NextResponse.json(
        { error: "invalid spec", issues: (e as { issues: unknown }).issues },
        { status: 400 }
      );
    }
    const message = e instanceof Error ? e.message : "provisioning failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
