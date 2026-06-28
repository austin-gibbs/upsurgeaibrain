// =====================================================================
// /api/console/team-members
//
// GET  — list app admins (profiles.is_admin = true).
// POST — create a new login (full name + email + password) and grant it app
//        admin, which means full cross-org access to every workspace (RLS
//        is_app_admin bypass). Session + admin gated.
//
// The Supabase Admin API (service role) creates the auth user with the chosen
// password and email pre-confirmed, so they can sign in immediately.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const db = createServiceClient();
  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name, is_admin, created_at")
    .eq("is_admin", true)
    .order("created_at", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, admins: data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const json = (await req.json().catch(() => null)) as {
    fullName?: unknown;
    email?: unknown;
    password?: unknown;
  } | null;
  if (!json || typeof json !== "object") {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const fullName = String(json.fullName ?? "").trim();
  const email = String(json.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(json.password ?? "");

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "a valid email is required" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const db = createServiceClient();

  // 1. Create the auth user with the chosen password (email pre-confirmed).
  const { data: created, error: createErr } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (createErr || !created?.user) {
    return NextResponse.json(
      { error: createErr?.message ?? "failed to create user" },
      { status: 400 }
    );
  }

  // 2. Ensure the profile exists and is flagged admin (a DB trigger may have
  //    already inserted the row; upsert is idempotent).
  const { error: profErr } = await db.from("profiles").upsert(
    {
      id: created.user.id,
      email,
      full_name: fullName || null,
      is_admin: true,
    },
    { onConflict: "id" }
  );
  if (profErr) {
    return NextResponse.json(
      {
        error: `user created but failed to grant admin: ${profErr.message}`,
        userId: created.user.id,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    user: { id: created.user.id, email, full_name: fullName || null },
    message: `${email} can now sign in and has full access to all workspaces.`,
  });
}
