// =====================================================================
// GET /api/profile  — signed-in user's profile
// PATCH /api/profile — update profile fields (full_name)
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { resolveIsAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ProfileRow = {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
};

export async function GET() {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { data: profile, error } = await userClient
    .from("profiles")
    .select("id, email, full_name, is_admin")
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const isAdmin = await resolveIsAdmin(user.id, user.email);

  return NextResponse.json({
    id: user.id,
    email: profile?.email ?? user.email ?? "",
    full_name: profile?.full_name ?? null,
    is_admin: isAdmin,
  });
}

const patchSchema = z.object({
  full_name: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional(),
});

export async function PATCH(req: NextRequest) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const json = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  if (parsed.data.full_name === undefined) {
    return NextResponse.json(
      { error: "nothing to update" },
      { status: 400 }
    );
  }

  const fullName =
    parsed.data.full_name === null || parsed.data.full_name === ""
      ? null
      : parsed.data.full_name;

  const db = createServiceClient();
  const { data: updated, error } = await db
    .from("profiles")
    .update({ full_name: fullName })
    .eq("id", user.id)
    .select("id, email, full_name, is_admin")
    .single<ProfileRow>();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const isAdmin = await resolveIsAdmin(user.id, user.email);

  return NextResponse.json({
    id: updated.id,
    email: updated.email,
    full_name: updated.full_name,
    is_admin: isAdmin,
  });
}
