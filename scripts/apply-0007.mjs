#!/usr/bin/env node
/**
 * Apply migration 0007 (reporting fields) via Supabase Management API.
 *
 * Requires in .env.local:
 *   SUPABASE_ACCESS_TOKEN  — Dashboard → Account → Access Tokens
 *   NEXT_PUBLIC_SUPABASE_URL
 *
 * Usage:
 *   set -a && source .env.local && set +a && node scripts/apply-0007.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
if (!token) {
  console.error("Missing SUPABASE_ACCESS_TOKEN.");
  console.error("Create one at https://supabase.com/dashboard/account/tokens");
  process.exit(1);
}
if (!url) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL.");
  process.exit(1);
}

const ref = new URL(url).hostname.split(".")[0];
const sql = fs.readFileSync(
  path.join(ROOT, "supabase/migrations/0007_reporting_fields.sql"),
  "utf8"
);

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
  console.error(`Migration 0007 failed (${res.status}):`, body);
  process.exit(1);
}

console.log("Migration 0007 applied successfully.");
if (body.trim()) console.log(body);
