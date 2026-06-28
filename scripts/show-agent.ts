#!/usr/bin/env -S npx tsx
/**
 * Read-only: print the agent(s) in a workspace — status, enroll tag, Retell
 * from-number, CRM status. Handy to confirm what tag to enroll a contact with
 * and whether the agent is active.
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   npx tsx scripts/show-agent.ts --workspace="UpSurge Test"
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

  const workspaceName = argValue("--workspace");
  if (!workspaceName) {
    console.error('Usage: npx tsx scripts/show-agent.ts --workspace="UpSurge Test"');
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

  const { data: workspaces, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, timezone, enroll_tag, created_at")
    .eq("name", workspaceName)
    .order("created_at", { ascending: false });
  if (wsErr) throw new Error(`workspace lookup failed: ${wsErr.message}`);
  if (!workspaces || workspaces.length === 0) {
    throw new Error(`No workspace named "${workspaceName}" found.`);
  }
  const ws = workspaces[0] as {
    id: string;
    name: string;
    timezone: string;
    enroll_tag: string | null;
  };

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select(
      "id, name, status, direction, enroll_tag, retell_from_number, crm_provider, crm_status, crm_status_detail"
    )
    .eq("workspace_id", ws.id);
  if (agErr) throw new Error(`agent lookup failed: ${agErr.message}`);

  console.log(
    JSON.stringify(
      {
        workspace: {
          id: ws.id,
          name: ws.name,
          timezone: ws.timezone,
          enroll_tag: ws.enroll_tag,
        },
        agents,
      },
      null,
      2
    )
  );

  for (const a of (agents ?? []) as Array<{
    name: string;
    enroll_tag: string | null;
  }>) {
    const tag = a.enroll_tag ?? ws.enroll_tag;
    console.log(`\nTo enroll a contact for "${a.name}", tag them: ${tag}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
