// =====================================================================
// GET /api/agents/:id/highlevel/connect — start the HighLevel OAuth flow.
//
// Authorizes the current user against the agent (RLS), mints a short-lived
// signed `state` binding the flow to this agent, and 302-redirects to the
// HighLevel authorize screen. HighLevel then redirects back to
// /api/oauth/highlevel/callback with a code we exchange for tokens.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { encryptJson } from "@/lib/crypto";
import { highLevelAuthorizeUrl } from "@/lib/crm/highlevel-oauth";

export const runtime = "nodejs";

function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/oauth/highlevel/callback`;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // RLS check: the user must be able to see this agent.
  const { data: visible } = await userClient
    .from("agents")
    .select("id")
    .eq("id", params.id)
    .single<{ id: string }>();
  if (!visible) return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    // State is AES-GCM encrypted (authenticated) so it can't be tampered with.
    const state = encryptJson({ agentId: params.id, ts: Date.now() });
    const url = highLevelAuthorizeUrl({
      redirectUri: callbackUrl(),
      state,
    });
    return NextResponse.redirect(url);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "failed to start HighLevel OAuth" },
      { status: 500 }
    );
  }
}
