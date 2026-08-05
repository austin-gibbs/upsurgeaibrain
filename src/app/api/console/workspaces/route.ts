// =====================================================================
// GET /api/console/workspaces
//
// Every workspace (+ its agents) for the admin console's workspace/agent
// pickers. The console's manage-existing routes are keyed by workspace NAME,
// so the picker exists to stop admins from having to type that name exactly.
//
// Uses the service client behind requireAdmin so the list is complete
// regardless of which orgs the admin happens to be a member of.
// =====================================================================
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const db = createServiceClient();
  const { data, error } = await db
    .from("workspaces")
    .select(
      "id, name, timezone, crm_provider, is_active, created_at, agents(id, name, status, direction)"
    )
    .order("name", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, workspaces: data ?? [] });
}
