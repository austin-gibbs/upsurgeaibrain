// =====================================================================
// Authorization helper.
//
// Several routes do an RLS-respecting read-check and THEN switch to the
// RLS-bypassing service client for the actual write. That pattern is correct,
// but fragile: a new route that forgets the pre-check would get cross-tenant
// access. `assertCanAccess` centralizes the check so it's a single, obvious,
// hard-to-skip call.
// =====================================================================
import type { createServerClient } from "@/lib/supabase/server";

/** The RLS-respecting server client (Server Components / Route Handlers). */
type UserClient = ReturnType<typeof createServerClient>;

/** Tables that have a top-level `id` column and are access-scoped by RLS. */
export type AccessScopedTable =
  | "agents"
  | "workspaces"
  | "contacts"
  | "calls"
  | "organizations";

/**
 * Returns true iff the signed-in user behind `userClient` can see row `id` in
 * `table` under RLS. Call this BEFORE doing privileged work with a service
 * (RLS-bypassing) client.
 */
export async function assertCanAccess(
  userClient: UserClient,
  table: AccessScopedTable,
  id: string
): Promise<boolean> {
  const { data } = await userClient
    .from(table)
    .select("id")
    .eq("id", id)
    .maybeSingle<{ id: string }>();
  return Boolean(data);
}
