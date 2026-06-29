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
import { assertCanAccess } from "@/lib/authz";
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
  let agentId: string | undefined;
  let workspaceId: string | undefined;
  let stateUserId: string | undefined;
  try {
    const decoded = decryptJson<{
      agentId?: string;
      workspaceId?: string;
      userId?: string;
      ts: number;
    }>(state);
    if ((!decoded.agentId && !decoded.workspaceId) || Date.now() - decoded.ts > STATE_MAX_AGE_MS) {
      throw new Error("state expired");
    }
    agentId = decoded.agentId;
    workspaceId = decoded.workspaceId;
    stateUserId = decoded.userId;
  } catch {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }

  // The same browser carries the session cookie — re-check access before writing.
  const userClient = createServerClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (stateUserId && stateUserId !== user.id) {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }

  if (agentId) {
    if (!(await assertCanAccess(userClient, "agents", agentId))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  } else if (workspaceId) {
    if (!(await assertCanAccess(userClient, "workspaces", workspaceId))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  } else {
    return NextResponse.json({ error: "invalid state" }, { status: 400 });
  }

  const fail = (reason: string) => {
    if (agentId) {
      return NextResponse.redirect(
        appUrl(
          `/agents/${agentId}?tab=crm&crm=error&reason=${encodeURIComponent(reason)}`
        )
      );
    }
    return NextResponse.redirect(
      appUrl(
        `/workspaces/${workspaceId}?tab=operations&crm=error&reason=${encodeURIComponent(reason)}`
      )
    );
  };

  // Exchange the code and persist tokens on the agent or workspace row.
  try {
    const tokens = await exchangeHighLevelCode(code, crmOAuthCallbackUrl());
    if (!tokens.locationId) {
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

    if (workspaceId) {
      const { data: updated, error: updateError } = await db
        .from("workspaces")
        .update({
          crm_provider: "highlevel",
          crm_credentials_encrypted: encryptJson(creds),
          crm_status: "connected",
          crm_status_detail: null,
        })
        .eq("id", workspaceId)
        .select("id");

      if (updateError) {
        return fail(`Saving the connection failed: ${updateError.message}`);
      }
      if (!updated || updated.length === 0) {
        return fail(
          "Connected to HighLevel but the workspace row was not found to save tokens."
        );
      }

      return NextResponse.redirect(
        appUrl(`/workspaces/${workspaceId}?tab=operations&crm=connected`)
      );
    }

    const { data: updated, error: updateError } = await db
      .from("agents")
      .update({
        crm_provider: "highlevel",
        crm_credentials_encrypted: encryptJson(creds),
        crm_status: "connected",
        crm_status_detail: null,
      })
      .eq("id", agentId!)
      .select("id");

    if (updateError) {
      return fail(`Saving the connection failed: ${updateError.message}`);
    }
    if (!updated || updated.length === 0) {
      return fail("Connected to HighLevel but the agent row was not found to save tokens.");
    }

    return NextResponse.redirect(appUrl(`/agents/${agentId}?tab=crm&crm=connected`));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "CRM token exchange failed";
    return fail(message);
  }
}
