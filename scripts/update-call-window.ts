#!/usr/bin/env -S npx tsx
/**
 * Update the call window / cadence for the agent(s) in a workspace.
 *
 * Writes to `agent_call_configs` (keyed by agent_id). Defaults encode
 * "call once a day at 11pm local for 30 days":
 *   call_window_start 23:00, call_window_end 23:59, daily_run_at 23:00,
 *   cadence_day_gaps [1], max_attempts_per_contact 30.
 * The window is enforced in the workspace's own timezone (set on the
 * workspace row), so "11pm" means 11pm Mountain for an America/Denver ws.
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   npx tsx scripts/update-call-window.ts --workspace="UpSurge Test"
 *   npx tsx scripts/update-call-window.ts --workspace="UpSurge Test" \
 *     --start=23:00 --end=23:59 --run-at=23:00 --gap=1 --attempts=30
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
    console.error(
      'Usage: npx tsx scripts/update-call-window.ts --workspace="UpSurge Test"'
    );
    process.exit(1);
  }
  const start = argValue("--start") ?? "23:00";
  const end = argValue("--end") ?? "23:59";
  const runAt = argValue("--run-at") ?? "23:00";
  const gap = Number(argValue("--gap") ?? "1");
  const attempts = Number(argValue("--attempts") ?? "30");

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
    .select("id, name, timezone, created_at")
    .eq("name", workspaceName)
    .order("created_at", { ascending: false });
  if (wsErr) throw new Error(`workspace lookup failed: ${wsErr.message}`);
  if (!workspaces || workspaces.length === 0) {
    throw new Error(`No workspace named "${workspaceName}" found.`);
  }
  const ws = workspaces[0] as { id: string; name: string; timezone: string };

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select("id, name")
    .eq("workspace_id", ws.id);
  if (agErr) throw new Error(`agent lookup failed: ${agErr.message}`);
  if (!agents || agents.length === 0) {
    throw new Error(`No agents in workspace "${ws.name}".`);
  }

  const patch = {
    call_window_start: start,
    call_window_end: end,
    daily_run_at: runAt,
    cadence_day_gaps: [gap],
    max_attempts_per_contact: attempts,
    updated_at: new Date().toISOString(),
  };

  for (const agent of agents as Array<{ id: string; name: string }>) {
    const { error } = await db
      .from("agent_call_configs")
      .upsert({ agent_id: agent.id, ...patch }, { onConflict: "agent_id" });
    if (error) {
      throw new Error(`failed to update config for agent ${agent.id}: ${error.message}`);
    }
    console.log(`Updated ${agent.name} (${agent.id})`);
  }

  console.log("\nApplied call config:");
  console.log(
    JSON.stringify(
      { workspace: ws.name, timezone: ws.timezone, ...patch },
      null,
      2
    )
  );
  console.log(
    `\nThe agent(s) will now dial once per day at ${runAt} ${ws.timezone} ` +
      `(window ${start}-${end}), up to ${attempts} days.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
