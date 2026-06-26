#!/usr/bin/env -S npx tsx
/**
 * Fulfillment report (App-DB-only) — prints the twice-daily #fulfillment
 * update for all active workspaces.
 *
 * This is the mechanism the scheduled Slack task runs, so it has NO deploy
 * dependency: it talks to Supabase directly with the service-role key.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Usage:
 *   npx tsx scripts/fulfillment-report.ts            # Slack markdown (default)
 *   npx tsx scripts/fulfillment-report.ts --json     # raw JSON
 *   npx tsx scripts/fulfillment-report.ts --tz=America/Denver
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  buildFulfillmentReport,
  formatFulfillmentSlack,
} from "../src/lib/reporting/fulfillment";

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

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
    process.exit(1);
  }

  const tz = argValue("--tz") ?? "America/Denver";
  const asJson = process.argv.includes("--json");

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const report = await buildFulfillmentReport(db, { tz });

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatFulfillmentSlack(report) + "\n");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
