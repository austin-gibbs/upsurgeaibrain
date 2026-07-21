import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on page navigations only. All /api/* routes self-authenticate and
  // must never be blocked by a middleware hang (Vercel MIDDLEWARE_INVOCATION_TIMEOUT
  // returns a plain-text 504 that clients then fail to parse as JSON).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
