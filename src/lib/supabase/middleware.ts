// Refreshes the Supabase auth session on every request and guards routes.
// Imported by src/middleware.ts.
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";
import type { User } from "@supabase/supabase-js";

const PUBLIC_PATHS = ["/login", "/auth"];

/** Keep well under Vercel's Edge middleware limit so a slow Auth call never 504s. */
const GET_USER_TIMEOUT_MS = 3_000;

type AuthLookup =
  | { status: "ok"; user: User | null }
  | { status: "timeout" }
  | { status: "error" };

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Race getUser against a timer. If Auth hangs, continue rather than let
  // Vercel kill the middleware with MIDDLEWARE_INVOCATION_TIMEOUT (plain-text
  // 504 that client .json() calls cannot parse).
  const auth = await getUserWithTimeout(supabase);

  // On timeout/error, skip redirects and let the request through — pages and
  // API routes re-check auth themselves. Avoids bouncing signed-in users to
  // /login just because Auth was briefly slow.
  if (auth.status !== "ok") {
    return response;
  }

  const user = auth.user;
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirectedFrom", path);
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}

async function getUserWithTimeout(
  supabase: ReturnType<typeof createServerClient<Database>>
): Promise<AuthLookup> {
  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), GET_USER_TIMEOUT_MS)
      ),
    ]);

    if (result === "timeout") {
      console.warn(
        `[middleware] supabase.auth.getUser timed out after ${GET_USER_TIMEOUT_MS}ms`
      );
      return { status: "timeout" };
    }

    return { status: "ok", user: result.data.user };
  } catch (err) {
    console.warn(
      "[middleware] supabase.auth.getUser failed:",
      err instanceof Error ? err.message : err
    );
    return { status: "error" };
  }
}
