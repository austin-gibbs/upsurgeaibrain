#!/usr/bin/env node
/**
 * Prints the Vercel env vars required for real-time Retell webhook processing.
 * Compare against Railway/worker — both must match or webhooks 401 and reconcile
 * becomes the only writeback path (11+ minute delay).
 *
 * Usage: node scripts/print-vercel-env-checklist.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, "..", ".env.local");

function loadEnvLocal() {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

loadEnvLocal();

const REQUIRED = [
  "RETELL_WEBHOOK_SECRET",
  "CREDENTIALS_ENCRYPTION_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

console.log("=== Vercel production env checklist (values from .env.local) ===\n");
for (const key of REQUIRED) {
  const set = Boolean(process.env[key]?.trim());
  console.log(`${set ? "✓" : "✗"} ${key}: ${set ? "present locally" : "MISSING locally"}`);
}

console.log(`
Set these on the Vercel project (upsurgeaiagentapp / upsurgeprosai.com):
  vercel env add RETELL_WEBHOOK_SECRET production
  vercel env add CREDENTIALS_ENCRYPTION_KEY production

RETELL_WEBHOOK_SECRET must match the signing key in the Retell agent dashboard.
CREDENTIALS_ENCRYPTION_KEY must match Railway/worker exactly (same openssl rand -base64 32 value).

Retell webhook URL for each agent:
  https://upsurgeprosai.com/api/webhooks/retell

After updating Vercel env, redeploy and verify:
  curl -H "Authorization: Bearer $CRON_SECRET" \\
    https://upsurgeprosai.com/api/admin/webhook-health

healthy:true and recentTiming with dialToCompleteSeconds < 120 means the fix worked.
`);
