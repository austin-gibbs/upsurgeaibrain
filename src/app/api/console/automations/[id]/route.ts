// =====================================================================
// /api/console/automations/[id]
//
// PATCH  { ...partial trigger }  -> update a trigger (merge). The URL invariant
//        (webhook/highlevel_sms need action_config.url) is re-checked against
//        the merged row so you can't disable a URL out from under a live action.
// DELETE                          -> delete a trigger. Its run history remains
//        (automation_runs.trigger_id is ON DELETE SET NULL) for the audit log.
//
// Admin (cross-org) gated. Keyed by the trigger's own id.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";
import { automationTriggerUpdateSchema } from "@/lib/engine/automations/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const json = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = automationTriggerUpdateSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid trigger patch", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: existing, error: getErr } = await db
    .from("automation_triggers")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "trigger not found" }, { status: 404 });

  const merged = { ...existing, ...parsed.data };
  const effectiveActionType = merged.action_type;
  const effectiveConfig = (merged.action_config ?? {}) as { url?: string };
  if (effectiveActionType !== "internal_notify" && !effectiveConfig.url) {
    return NextResponse.json(
      { error: `action_config.url is required for action_type="${effectiveActionType}"` },
      { status: 400 }
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(parsed.data)) {
    patch[k] = k === "description" || k === "only_outcomes" ? v ?? null : v;
  }

  const { data, error } = await db
    .from("automation_triggers")
    .update(patch as never)
    .eq("id", params.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, trigger: data });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const db = createServiceClient();
  const { error } = await db.from("automation_triggers").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: params.id });
}
