#!/usr/bin/env -S npx tsx
/**
 * Audit (and optionally re-bind) Retell agent-level webhook URLs for active
 * inbound agents. Inbound calls have no per-dial webhook_url, so delivery
 * depends entirely on this binding.
 *
 * Requires in .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   CREDENTIALS_ENCRYPTION_KEY
 *
 * Usage:
 *   npx tsx scripts/verify-inbound-webhooks.ts
 *   npx tsx scripts/verify-inbound-webhooks.ts --workspace="United Real Estate Experts"
 *   npx tsx scripts/verify-inbound-webhooks.ts --workspace="United Real Estate Experts" --fix
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  appRetellWebhookUrl,
  bindRetellWebhookForAgent,
} from "../src/lib/retell/webhook-bind";
import { decryptJson } from "../src/lib/crypto";
import type { RetellCredentials } from "../src/lib/retell/client";
import type { Agent } from "../src/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RETELL_BASE = "https://api.retellai.com";

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

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveApiKey(agent: Agent): string {
  if (agent.retell_credentials_encrypted) {
    try {
      const creds = decryptJson<RetellCredentials>(agent.retell_credentials_encrypted);
      if (creds.apiKey?.trim()) return creds.apiKey.trim();
    } catch {
      /* fall through */
    }
  }
  const env = process.env.RETELL_API_KEY?.trim();
  if (!env) throw new Error("no Retell API key (agent or RETELL_API_KEY)");
  return env;
}

async function main() {
  loadEnvLocal();

  const workspaceName = argValue("--workspace");
  const fix = hasFlag("--fix");
  const expectedUrl = appRetellWebhookUrl();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local"
    );
    process.exit(1);
  }
  if (!process.env.CREDENTIALS_ENCRYPTION_KEY?.trim()) {
    console.error("Missing CREDENTIALS_ENCRYPTION_KEY — cannot decrypt per-agent Retell keys.");
    process.exit(1);
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let workspaceId: string | null = null;
  if (workspaceName) {
    const { data: ws, error } = await db
      .from("workspaces")
      .select("id, name")
      .eq("name", workspaceName)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!ws) throw new Error(`No workspace named "${workspaceName}"`);
    workspaceId = ws.id;
    console.log(`Workspace: ${ws.name} (${ws.id})`);
  }

  let query = db
    .from("agents")
    .select(
      "id, name, status, direction, retell_agent_id, retell_credentials_encrypted, workspace_id"
    )
    .eq("direction", "inbound")
    .eq("status", "active")
    .not("retell_agent_id", "is", null);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);

  const { data: agents, error: agErr } = await query;
  if (agErr) throw new Error(agErr.message);

  console.log(`Expected webhook URL: ${expectedUrl}`);
  console.log(`Active inbound agents: ${(agents ?? []).length}`);
  console.log(`Mode: ${fix ? "FIX (re-bind mismatched)" : "AUDIT (read-only)"}`);
  console.log("");

  let ok = 0;
  let missing = 0;
  let mismatched = 0;
  let failed = 0;

  for (const row of (agents ?? []) as Agent[]) {
    const label = `${row.name} (${row.retell_agent_id})`;
    if (!row.retell_agent_id) continue;

    try {
      const apiKey = resolveApiKey(row);
      const res = await fetch(`${RETELL_BASE}/get-agent/${row.retell_agent_id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      let webhookUrl: string | null = null;
      let analysisFields: string[] = [];
      if (res.ok) {
        const agentJson = (await res.json()) as {
          webhook_url?: string | null;
          post_call_analysis_data?: Array<{ name?: string }>;
        };
        webhookUrl = agentJson.webhook_url?.trim() || null;
        analysisFields = (agentJson.post_call_analysis_data ?? [])
          .map((f) => f.name)
          .filter((n): n is string => Boolean(n));
      } else {
        console.warn(`  ! could not GET agent (${res.status}) for ${label}`);
      }

      const bound = webhookUrl === expectedUrl;
      if (bound) {
        ok++;
        console.log(`✓ ${label}`);
        console.log(`    webhook_url: ${webhookUrl}`);
      } else if (!webhookUrl) {
        missing++;
        console.log(`✗ ${label}`);
        console.log(`    webhook_url: (null)`);
      } else {
        mismatched++;
        console.log(`✗ ${label}`);
        console.log(`    webhook_url: ${webhookUrl}`);
        console.log(`    expected:    ${expectedUrl}`);
      }
      if (analysisFields.length) {
        console.log(`    analysis fields: ${analysisFields.join(", ")}`);
      } else {
        console.log(`    analysis fields: (none reported)`);
      }

      if (fix && !bound) {
        await bindRetellWebhookForAgent(row);
        console.log(`    → re-bound to ${expectedUrl}`);
      }
    } catch (e) {
      failed++;
      console.error(
        `✗ ${label}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    console.log("");
  }

  console.log(
    JSON.stringify(
      { ok, missing, mismatched, failed, expectedUrl, fixed: fix },
      null,
      2
    )
  );

  if (missing + mismatched + failed > 0 && !fix) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
