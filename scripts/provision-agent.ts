#!/usr/bin/env -S npx tsx
/**
 * Provision a Retell agent end-to-end, directly (no deploy dependency).
 *
 * Runs the SAME orchestration as POST /api/admin/provision-agent, but talks
 * to Retell + Supabase directly using local credentials — handy for the
 * Claude/Cowork flow where the machine has network access to both.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   CREDENTIALS_ENCRYPTION_KEY     (to encrypt Retell/CRM creds at rest)
 *   NEXT_PUBLIC_APP_URL            (so the Retell webhook points at the app)
 * The client's Retell API key is supplied INSIDE the spec (retell.apiKey).
 *
 * Usage:
 *   npx tsx scripts/provision-agent.ts --spec=./my-agent.json
 *   npx tsx scripts/provision-agent.ts --spec=./my-agent.json --dry-run
 *
 * --dry-run validates the spec (Zod) and prints it back without creating
 * anything in Retell or the DB.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  provisionRetellAgent,
  provisionRetellAgentSchema,
} from "../src/lib/provisioning/provision-agent";

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

/** Redact secrets before printing a spec back to the console. */
function redact(spec: any): any {
  const clone = JSON.parse(JSON.stringify(spec));
  if (clone?.retell?.apiKey) clone.retell.apiKey = "***";
  if (clone?.retell?.webhookSecret) clone.retell.webhookSecret = "***";
  if (clone?.workspace?.crmCredentials) clone.workspace.crmCredentials = "***";
  if (clone?.agent?.crmCredentials) clone.agent.crmCredentials = "***";
  return clone;
}

async function main() {
  loadEnvLocal();

  const specPath = argValue("--spec");
  if (!specPath) {
    console.error("Missing --spec=<path-to-json>");
    process.exit(1);
  }
  const absSpec = path.resolve(process.cwd(), specPath);
  if (!fs.existsSync(absSpec)) {
    console.error(`Spec file not found: ${absSpec}`);
    process.exit(1);
  }
  const rawSpec = JSON.parse(fs.readFileSync(absSpec, "utf8"));

  // Validate up front so dry-run and real runs reject the same bad input.
  const parsed = provisionRetellAgentSchema.safeParse(rawSpec);
  if (!parsed.success) {
    console.error("Invalid spec:");
    console.error(JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  if (process.argv.includes("--dry-run")) {
    console.log("Spec is valid. Parsed (secrets redacted):");
    console.log(JSON.stringify(redact(parsed.data), null, 2));
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
    process.exit(1);
  }
  if (!process.env.CREDENTIALS_ENCRYPTION_KEY) {
    console.error("Missing CREDENTIALS_ENCRYPTION_KEY in .env.local");
    process.exit(1);
  }
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    console.warn(
      "[warn] NEXT_PUBLIC_APP_URL is not set — the Retell agent will be created without a webhook URL, so call_analyzed outcomes won't be delivered."
    );
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await provisionRetellAgent(db, rawSpec);
  console.log("Provisioned:");
  console.log(JSON.stringify(result, null, 2));
  if (result.activationBlockedReason) {
    console.warn(
      `\n[note] Agent created as DRAFT — activation was blocked: ${result.activationBlockedReason}`
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
