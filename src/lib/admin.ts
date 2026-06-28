// =====================================================================
// Admin gating for the in-app provisioning console.
//
// The console pages + /api/console/* routes are session-based (so they pass
// through middleware and Supabase auth) AND restricted to app admins. This is
// distinct from the headless /api/admin/provision-agent endpoint, which is
// gated by the PROVISION_API_KEY bearer secret instead.
//
// Admin status is DB-backed (profiles.is_admin) so admins can be added from
// the console without a redeploy. ADMIN_EMAILS (comma-separated,
// case-insensitive) is a BOOTSTRAP allowlist only: any email listed there is
// treated as admin and self-healed into profiles.is_admin on first use, so the
// owner is always an admin even on a fresh database. Adding teammates later is
// done purely in the DB via the console.
// =====================================================================
import { createServerClient, createServiceClient } from "@/lib/supabase/server";

/** Parsed, lowercased admin allowlist from ADMIN_EMAILS. */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.trim().toLowerCase());
}

/**
 * Returns true when the user is an app admin (DB flag or ADMIN_EMAILS bootstrap).
 * Bootstrap emails are self-healed into profiles.is_admin so RLS applies.
 */
export async function resolveIsAdmin(
  userId: string,
  email: string | null | undefined
): Promise<boolean> {
  const db = createServiceClient();

  const { data: profile } = await db
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.is_admin) return true;

  if (isAdminEmail(email)) {
    await db
      .from("profiles")
      .upsert(
        { id: userId, email: email ?? "", is_admin: true },
        { onConflict: "id" }
      );
    return true;
  }

  return false;
}

export type AdminGuardResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Verify the request carries a signed-in session for an app admin. Admin is
 * either profiles.is_admin (DB-backed, addable via the console) OR an email on
 * the ADMIN_EMAILS bootstrap allowlist — in which case the flag is self-healed
 * into the DB so RLS (is_app_admin) grants full workspace access too.
 *
 * Returns the user on success, or a status + message to return. Uses the
 * session (RLS) client for auth; writes go through the service client.
 */
export async function requireAdmin(): Promise<AdminGuardResult> {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();

  if (!user) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  const isAdmin = await resolveIsAdmin(user.id, user.email);
  if (isAdmin) {
    return { ok: true, userId: user.id, email: user.email ?? "" };
  }

  return { ok: false, status: 403, error: "forbidden: not an admin" };
}
