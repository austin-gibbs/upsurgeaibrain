// =====================================================================
// GET /api/oauth/highlevel/callback — finish the HighLevel OAuth flow.
//
// HighLevel redirects here with `code` + the signed `state` we minted in
// the connect route. We exchange the code for tokens, then store them
// (access + refresh + expiry + locationId) encrypted on the agent so the
// adapter can auto-refresh from then on.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { exchangeHighLevelCode } from "@/lib/crm/highlevel-oauth";
import type { HighLevelCredentials } from "@/lib/crm/types";

export const runtime = "nodejs";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function callbackUrl(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}/api/oauth/highlevel/callback`;
}

function appUrl(path: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(appUrl(`/?highlevel=error`));
  }
  if (!code || !state) {
    return NextResponse.json({ error: "missing code or state" }, { status: 400 });
  }

  // Verify + decode the signed state.
  let agentId: string;
  try {
    const decoded = decryptJson<{ agentId: string; ts: number }>(state);
    if (!decoded.agentId || Date.now() - decoded.ts > STATE_MAX_AGE_MS) {
      throw new Error("state expired");
    }
    agentId = decoded.agentId;
  } catch {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }

  // The same browser carries the session cookie — re-check the user can see
  // this agent before writing credentials to it.
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: visible } = await userClient
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .single<{ id: string }>();
  if (!visible) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Exchange the code and persist the tokens encrypted on the agent.
  try {
    const tokens = await exchangeHighLevelCode(code, callbackUrl());
    if (!tokens.locationId) {
      throw new Error("HighLevel did not return a locationId for this token");
    }
    const creds: HighLevelCredentials = {
      accessToken: tokens.accessToken,
      locationId: tokens.locationId,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
    const db = createServiceClient();
    await db
      .from("agents")
      .update({
        crm_provider: "highlevel",
        crm_credentials_encrypted: encryptJson(creds),
      })
      .eq("id", agentId);

    return NextResponse.redirect(appUrl(`/agents/${agentId}?highlevel=connected`));
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "HighLevel token exchange failed" },
      { status: 502 }
    );
  }
}
