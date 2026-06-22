// =====================================================================
// Supabase clients for server-side use.
//
//  - createServerClient(): respects the signed-in user + RLS. Use in
//    Server Components, Route Handlers, and Server Actions.
//  - createServiceClient(): SERVICE ROLE, bypasses RLS. Use ONLY in the
//    background engine, webhooks, and cron — never with user input you
//    haven't authorized.
// =====================================================================
import { cookies } from "next/headers";
import { createServerClient as createSSRClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

export function createServerClient() {
  const cookieStore = cookies();
  return createSSRClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(toSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // called from a Server Component — safe to ignore, middleware refreshes
          }
        },
      },
    }
  );
}

let serviceSingleton: ReturnType<typeof createClient<Database>> | null = null;

export function createServiceClient() {
  if (serviceSingleton) return serviceSingleton;
  serviceSingleton = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return serviceSingleton;
}
