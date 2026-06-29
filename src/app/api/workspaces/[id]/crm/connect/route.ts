// =====================================================================
// GET /api/workspaces/:id/crm/connect — start workspace-level HighLevel OAuth.
//
// Stores tokens on the workspace so all inheriting agents share one refresh
// token (avoids sibling de-auth when multiple agents OAuth the same location).
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

  if (!(await assertCanAccess(userClient, "workspaces", params.id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const state = encryptJson({
      workspaceId: params.id,
      userId: user.id,
      ts: Date.now(),
    });
    const url = highLevelAuthorizeUrl({
      redirectUri: crmOAuthCallbackUrl(),
      state,
    });
    return NextResponse.redirect(url);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "failed to start CRM OAuth";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
