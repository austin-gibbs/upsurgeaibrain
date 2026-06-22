// =====================================================================
// POST /api/crm/verify
// Wizard helper: checks CRM credentials live (and optionally returns the
// assignable users so the task step can show a dropdown). Credentials are
// never persisted here — this is a pre-save validation only.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { buildAdapter } from "@/lib/crm";
import { z } from "zod";
import { crmCredentialsSchema } from "@/lib/validation";

export const runtime = "nodejs";

const schema = z.object({
  crm_provider: z.enum(["followupboss", "highlevel"]),
  credentials: crmCredentialsSchema,
  includeUsers: z.boolean().optional().default(false),
});

export async function POST(req: NextRequest) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const json = await req.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const adapter = buildAdapter(
      parsed.data.crm_provider,
      parsed.data.credentials as any
    );
    const ok = await adapter.verifyCredentials();
    if (!ok) {
      return NextResponse.json(
        { ok: false, error: "Credentials failed verification" },
        { status: 200 }
      );
    }

    let users: Array<{ id: string; name: string }> = [];
    if (parsed.data.includeUsers) {
      try {
        users = await adapter.listUsers();
      } catch {
        // Non-fatal: verification still succeeded.
      }
    }

    return NextResponse.json({ ok: true, users });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e.message ?? "verification error" },
      { status: 200 }
    );
  }
}
