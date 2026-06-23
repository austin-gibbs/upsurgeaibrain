#!/usr/bin/env node
/**
 * Verify required schema columns exist on the linked Supabase project.
 *
 * Tries Supabase Management API first (needs SUPABASE_ACCESS_TOKEN).
 * Falls back to probing via service role (SUPABASE_SERVICE_ROLE_KEY).
 *
 * Usage:
 *   set -a && source .env.local && set +a && node scripts/verify-schema.mjs
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

loadEnvLocal();

const token = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!url) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL in .env.local");
  process.exit(1);
}

const CHECKS = [
  { table: "workspaces", column: "crm_account_url", migration: "0007" },
  { table: "agents", column: "enroll_tag", migration: "0004" },
  { table: "agents", column: "direction", migration: "0006" },
  { table: "agents", column: "crm_provider", migration: "0006" },
  { table: "calls", column: "direction", migration: "0005" },
  { table: "contacts", column: "email", migration: "0007" },
  {
    table: "agent_task_configs",
    column: "post_call_webhook_enabled",
    migration: "0008",
  },
  {
    table: "agent_task_configs",
    column: "post_call_webhook_url",
    migration: "0008",
  },
];

async function verifyViaManagementApi() {
  if (!token) return null;
  const ref = new URL(url).hostname.split(".")[0];
  const sql = `
select table_name, column_name
from information_schema.columns
where table_schema = 'public'
  and (${CHECKS.map(
    (c) => `(table_name = '${c.table}' and column_name = '${c.column}')`
  ).join(" or ")})
order by table_name, column_name;
`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.warn(`Management API verify failed (${res.status}): ${body}`);
    return null;
  }
  const rows = JSON.parse(body);
  return new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
}

async function verifyViaServiceRole() {
  if (!serviceKey) {
    console.error(
      "Need SUPABASE_ACCESS_TOKEN or SUPABASE_SERVICE_ROLE_KEY to verify schema."
    );
    process.exit(1);
  }
  const db = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const missing = [];
  for (const check of CHECKS) {
    const { error } = await db.from(check.table).select(check.column).limit(1);
    if (error) {
      const msg = error.message ?? "";
      if (
        msg.includes("does not exist") ||
        msg.includes("Could not find") ||
        error.code === "42703"
      ) {
        missing.push(check);
      } else {
        console.warn(`Probe ${check.table}.${check.column}: ${msg}`);
      }
    }
  }
  return missing;
}

const found = await verifyViaManagementApi();
if (found) {
  const missing = CHECKS.filter((c) => !found.has(`${c.table}.${c.column}`));
  if (missing.length === 0) {
    console.log("Schema OK — all required columns present (0004–0008).");
    process.exit(0);
  }
  console.error("Schema INCOMPLETE — missing columns:");
  for (const m of missing) {
    console.error(`  - ${m.table}.${m.column} (migration ${m.migration})`);
  }
  console.error("\nRun: npm run db:apply-pending");
  process.exit(1);
}

console.log("Verifying schema via service role probes…");
const missing = await verifyViaServiceRole();
if (missing.length === 0) {
  console.log("Schema OK — all required columns present (0004–0008).");
  process.exit(0);
}

console.error("Schema INCOMPLETE — missing columns:");
for (const m of missing) {
  console.error(`  - ${m.table}.${m.column} (migration ${m.migration})`);
}
console.error("\nApply migrations 0004–0008:");
console.error("  npm run db:apply-pending   (needs SUPABASE_ACCESS_TOKEN)");
console.error("  — or run scripts/apply-pending-migrations.sql in Supabase SQL editor");
process.exit(1);
