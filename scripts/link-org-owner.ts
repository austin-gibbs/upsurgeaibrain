#!/usr/bin/env -S npx tsx
/**
 * One-off fix: make an already-created workspace visible to an app user.
 *
 * Why this exists: an earlier provisioning run created an org + workspace but
 * never linked them to a user, so Supabase RLS (`user_org_ids()`, which reads
 * `organization_members`) hid the workspace in production. The provisioner now
 * does this linkage automatically via `ownerEmail`; this script repairs rows
 * that predate that fix.
 *
 * What it does (idempotent):
 *   1. resolve the user by email -> profiles.id
 *   2. resolve the workspace by name -> its organization_id
 *   3. upsert organization_members { org, user, role: "owner" }
 *   4. backfill created_by on the org and workspace if null
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   npx tsx scripts/link-org-owner.ts --email=you@example.com --workspace="UpSurge Test"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

async function main() {
  loadEnvLocal();

  const email = argValue("--email");
  const workspaceName = argValue("--workspace");
  if (!email || !workspaceName) {
    console.error(
      'Usage: npx tsx scripts/link-org-owner.ts --email=you@example.com --workspace="UpSurge Test"'
    );
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
    process.exit(1);
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. user
  const { data: profile, error: profErr } = await db
    .from("profiles")
    .select("id, email")
    .eq("email", email)
    .maybeSingle<{ id: string; email: string }>();
  if (profErr) throw new Error(`profile lookup failed: ${profErr.message}`);
  if (!profile) {
    throw new Error(
      `No app user found with email "${email}". Sign in to the app once with that email first, then re-run.`
    );
  }

  // 2. workspace (newest match if names collide)
  const { data: workspaces, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, organization_id, created_by, created_at")
    .eq("name", workspaceName)
    .order("created_at", { ascending: false });
  if (wsErr) throw new Error(`workspace lookup failed: ${wsErr.message}`);
  if (!workspaces || workspaces.length === 0) {
    throw new Error(`No workspace named "${workspaceName}" found.`);
  }
  if (workspaces.length > 1) {
    console.warn(
      `[warn] ${workspaces.length} workspaces named "${workspaceName}" — linking the most recent (id ${workspaces[0].id}).`
    );
  }
  const ws = workspaces[0] as {
    id: string;
    name: string;
    organization_id: string;
    created_by: string | null;
  };

  // 3. membership (idempotent)
  const { error: memErr } = await db.from("organization_members").upsert(
    { organization_id: ws.organization_id, user_id: profile.id, role: "owner" },
    { onConflict: "organization_id,user_id" }
  );
  if (memErr) throw new Error(`membership upsert failed: ${memErr.message}`);

  // 4. backfill created_by where null
  const { data: org } = await db
    .from("organizations")
    .select("id, created_by")
    .eq("id", ws.organization_id)
    .maybeSingle<{ id: string; created_by: string | null }>();
  if (org && !org.created_by) {
    const { error } = await db
      .from("organizations")
      .update({ created_by: profile.id })
      .eq("id", ws.organization_id);
    if (error) console.warn(`[warn] org created_by backfill failed: ${error.message}`);
  }
  if (!ws.created_by) {
    const { error } = await db
      .from("workspaces")
      .update({ created_by: profile.id })
      .eq("id", ws.id);
    if (error) console.warn(`[warn] workspace created_by backfill failed: ${error.message}`);
  }

  console.log("Linked:");
  console.log(
    JSON.stringify(
      {
        user: { id: profile.id, email: profile.email },
        organizationId: ws.organization_id,
        workspaceId: ws.id,
        workspaceName: ws.name,
        role: "owner",
      },
      null,
      2
    )
  );
  console.log(`\n"${ws.name}" should now be visible in the app for ${email}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
