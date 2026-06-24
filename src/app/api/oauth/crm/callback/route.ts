// =====================================================================
// GET /api/oauth/crm/callback — finish the CRM OAuth flow (HighLevel).
//
// The provider redirects here with `code` + the signed `state` we minted in
// the connect route. We exchange the code for tokens, then store them
// (access + refresh + expiry + locationId) encrypted on the agent so the
// adapter can auto-refresh from then on.
// =====================================================================
import { NextRequest, NextResponse } from "next/server";
import { createServerClient, createServiceClient } from "@/lib/supabase/server";
import { decryptJson, encryptJson } from "@/lib/crypto";
import {
  crmOAuthCallbackUrl,
  exchangeHighLevelCode,
} from "@/lib/crm/highlevel-oauth";
import type { HighLevelCredentials } from "@/lib/crm/types";

export const runtime = "nodejs";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function appUrl(path: string): string {
  // `||` so an empty/whitespace value falls back instead of yielding a
  // host-less redirect; mirrors crmOAuthCallbackUrl().
  const base = (process.env.NEXT_PUBLIC_APP_URL || "").trim() || "http://localhost:3000";
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(appUrl(`/?crm=error`));
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

  // Send the user back to the agent with a human-readable reason on failure,
  // so a broken connect doesn't dead-end on a raw JSON error (and so we never
  // report "connected" when nothing was actually persisted).
  const fail = (reason: string) =>
    NextResponse.redirect(
      appUrl(`/agents/${agentId}?crm=error&reason=${encodeURIComponent(reason)}`)
    );

  // Exchange the code and persist the tokens encrypted on the agent.
  try {
    const tokens = await exchangeHighLevelCode(code, crmOAuthCallbackUrl());
    if (!tokens.locationId) {
      // Almost always means the app was authorized at the agency/company level
      // instead of selecting a sub-account (Location) on the chooselocation
      // screen, or the Marketplace app isn't distributed as a sub-account app.
      return fail(
        "HighLevel returned no locationId — re-run Connect and pick the sub-account (Location), and confirm the Marketplace app is a Sub-Account app."
      );
    }
    const creds: HighLevelCredentials = {
      accessToken: tokens.accessToken,
      locationId: tokens.locationId,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
    const db = createServiceClient();
    const { data: updated, error: updateError } = await db
      .from("agents")
      .update({
        crm_provider: "highlevel",
        crm_credentials_encrypted: encryptJson(creds),
      })
      .eq("id", agentId)
      .select("id");

    if (updateError) {
      return fail(`Saving the connection failed: ${updateError.message}`);
    }
    if (!updated || updated.length === 0) {
      // Token exchange succeeded but no row matched — the connection was NOT
      // saved. Surface it instead of redirecting with a false "connected".
      return fail("Connected to HighLevel but the agent row was not found to save tokens.");
    }

    return NextResponse.redirect(appUrl(`/agents/${agentId}?crm=connected`));
  } catch (e: any) {
    return fail(e?.message ?? "CRM token exchange failed");
  }
}
