#!/usr/bin/env -S npx tsx
/**
 * List recent Retell calls for one or more UpSurge agents (debug).
 * Usage: npx tsx scripts/list-retell-calls.ts --agent-id=<uuid> [--hours=72]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "../src/lib/crypto";
import type { RetellCredentials } from "../src/lib/retell/client";

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
  const agentId = argValue("--agent-id");
  const workspace = argValue("--workspace");
  const hours = Number(argValue("--hours") ?? "72");
  if (!agentId && !workspace) {
    console.error("Need --agent-id=... or --workspace=...");
    process.exit(1);
  }

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  let query = db
    .from("agents")
    .select("id,name,retell_agent_id,retell_credentials_encrypted,direction,status");
  if (agentId) query = query.eq("id", agentId);
  if (workspace) {
    const { data: ws } = await db
      .from("workspaces")
      .select("id")
      .eq("name", workspace)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!ws) throw new Error(`workspace not found: ${workspace}`);
    query = query.eq("workspace_id", ws.id).eq("direction", "inbound");
  }

  const { data: agents, error } = await query;
  if (error) throw new Error(error.message);

  const since = Date.now() - hours * 3600_000;
  for (const agent of agents ?? []) {
    console.log(`\n=== ${agent.name} (${agent.retell_agent_id}) [${agent.direction}/${agent.status}]`);
    if (!agent.retell_agent_id || !agent.retell_credentials_encrypted) {
      console.log("  missing retell id or creds");
      continue;
    }
    const creds = decryptJson<RetellCredentials>(agent.retell_credentials_encrypted);
    const res = await fetch("https://api.retellai.com/v3/list-calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter_criteria: {
          agent_id: [agent.retell_agent_id],
          start_timestamp: { lower_threshold: since },
        },
        limit: 20,
        sort_order: "descending",
      }),
    });
    const body = (await res.json()) as { items?: any[]; message?: string };
    const items = body.items ?? [];
    console.log(`  http=${res.status} count=${items.length}`);
    for (const c of items.slice(0, 10)) {
      console.log(
        JSON.stringify({
          call_id: c.call_id,
          direction: c.direction,
          status: c.call_status,
          from: c.from_number,
          to: c.to_number,
          start: c.start_timestamp ? new Date(c.start_timestamp).toISOString() : null,
          duration_ms: c.duration_ms,
          has_analysis: !!c.call_analysis,
          disconnection: c.disconnection_reason,
        })
      );
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
