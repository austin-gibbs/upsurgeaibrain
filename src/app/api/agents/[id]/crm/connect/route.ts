// =====================================================================
// GET /api/agents/:id/crm/connect — start workspace CRM OAuth (HighLevel).
//
// Authorizes the current user against the agent (RLS), mints a short-lived
// signed `state` binding the flow to the agent's workspace, and 302-redirects
// to the provider authorize screen. The provider then redirects back to
// /api/oauth/crm/callback with a code we exchange for tokens.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { encryptJson } from "@/lib/crypto";
import { assertCanAccess } from "@/lib/authz";
import {
  crmOAuthCallbackUrl,
  highLevelAuthorizeUrl,
} from "@/lib/crm/highlevel-oauth";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data: agent } = await userClient
    .from("agents")
    .select("id, workspace_id")
    .eq("id", params.id)
    .single<{ id: string; workspace_id: string }>();

  // RLS check: the user must be able to see this agent.
  if (!agent || !(await assertCanAccess(userClient, "agents", params.id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    // State is AES-GCM encrypted (authenticated) so it can't be tampered with.
    // Bind it to BOTH the workspace and the initiating user so a leaked/replayed
    // state can't be completed by a different session within its TTL.
    const state = encryptJson({
      workspaceId: agent.workspace_id,
      returnAgentId: params.id,
      userId: user.id,
      ts: Date.now(),
    });
    const url = highLevelAuthorizeUrl({
      redirectUri: crmOAuthCallbackUrl(),
      state,
    });
    return NextResponse.redirect(url);
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "failed to start CRM OAuth" },
      { status: 500 }
    );
  }
}
