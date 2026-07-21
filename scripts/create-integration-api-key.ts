#!/usr/bin/env -S npx tsx
/**
 * Mint a bearer API key for the custom-integration "trigger call" endpoint.
 *
 * The external app (e.g. SellMyFISBO) sends this token as
 *   Authorization: Bearer <token>
 * to POST /api/integrations/custom/trigger-call. We store ONLY the SHA-256 hash
 * (integration_api_keys.token_hash); the plaintext token is printed ONCE here
 * and never persisted — copy it now, you cannot recover it later.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   npx tsx scripts/create-integration-api-key.ts \
 *     --workspace=<workspace-uuid> \
 *     --agent=<agent-uuid> \
 *     --label="SellMyFISBO Lovable app"
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

async function main() {
  loadEnvLocal();

  const workspaceId = argValue("--workspace");
  const agentId = argValue("--agent");
  const label = argValue("--label") ?? "custom integration";
  if (!workspaceId) {
    console.error("Missing --workspace=<workspace-uuid>");
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

  // usk_ + 40 hex chars of CSPRNG entropy.
  const token = `usk_${crypto.randomBytes(20).toString("hex")}`;
  const tokenHash = sha256Hex(token);
  const tokenPrefix = token.slice(0, 12);

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await db
    .from("integration_api_keys")
    .insert({
      workspace_id: workspaceId,
      agent_id: agentId ?? null,
      token_hash: tokenHash,
      token_prefix: tokenPrefix,
      label,
      active: true,
    })
    .select("id")
    .single<{ id: string }>();

  if (error || !data) {
    console.error(`failed to create integration api key: ${error?.message}`);
    process.exit(1);
  }

  console.log("Integration API key created.");
  console.log(`  id:        ${data.id}`);
  console.log(`  workspace: ${workspaceId}`);
  console.log(`  agent:     ${agentId ?? "(none)"}`);
  console.log(`  label:     ${label}`);
  console.log("");
  console.log("  >>> COPY THIS TOKEN NOW — it is not stored and cannot be recovered:");
  console.log(`  ${token}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
