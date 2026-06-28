#!/usr/bin/env -S npx tsx
/**
 * Activate the agent(s) in a workspace — runs the SAME activation invariants
 * the app's PATCH /api/agents/:id uses (validateAgentActivation), then flips
 * status to "active". Use after CRM is connected so the poller will dial.
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Usage:
 *   npx tsx scripts/activate-agent.ts --workspace="UpSurge Test"
 *   npx tsx scripts/activate-agent.ts --workspace="UpSurge Test" --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { validateAgentActivation } from "../src/lib/agents/activation";
import { bindRetellWebhookForAgentSafe } from "../src/lib/retell/webhook-bind";

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
    console.error('Usage: npx tsx scripts/activate-agent.ts --workspace="UpSurge Test"');
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");

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
    .select(
      "id, name, enroll_tag, crm_provider, crm_credentials_encrypted, created_at"
    )
    .eq("name", workspaceName)
    .order("created_at", { ascending: false });
  if (wsErr) throw new Error(`workspace lookup failed: ${wsErr.message}`);
  if (!workspaces || workspaces.length === 0) {
    throw new Error(`No workspace named "${workspaceName}" found.`);
  }
  const ws = workspaces[0] as {
    id: string;
    name: string;
    enroll_tag: string;
    crm_provider: "followupboss" | "highlevel" | null;
    crm_credentials_encrypted: string | null;
  };

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select(
      "id, name, status, direction, enroll_tag, retell_agent_id, " +
        "retell_from_number, retell_credentials_encrypted, crm_provider, " +
        "crm_credentials_encrypted"
    )
    .eq("workspace_id", ws.id);
  if (agErr) throw new Error(`agent lookup failed: ${agErr.message}`);
  if (!agents || agents.length === 0) {
    throw new Error(`No agents in workspace "${ws.name}".`);
  }

  type AgentRow = {
    id: string;
    name: string;
    status: string;
    direction: "inbound" | "outbound";
    enroll_tag: string | null;
    retell_agent_id: string | null;
    retell_from_number: string | null;
    retell_credentials_encrypted: string | null;
    crm_provider: "followupboss" | "highlevel" | null;
    crm_credentials_encrypted: string | null;
  };
  const rows = agents as unknown as AgentRow[];
  const peerRows = rows.map((a) => ({
    id: a.id,
    direction: a.direction,
    enroll_tag: a.enroll_tag,
  }));

  for (const a of rows) {
    if (a.status === "active") {
      console.log(`- ${a.name}: already active, skipping.`);
      continue;
    }

    const { data: callConfigRow } = await db
      .from("agent_call_configs")
      .select("agent_id")
      .eq("agent_id", a.id)
      .maybeSingle();

    const blocked = validateAgentActivation({
      agentId: a.id,
      direction: a.direction,
      enrollTag: a.enroll_tag,
      retellAgentId: a.retell_agent_id,
      retellFromNumber: a.retell_from_number,
      retellCredentialsEncrypted: a.retell_credentials_encrypted,
      workspaceEnrollTag: ws.enroll_tag,
      existingAgents: peerRows,
      agent: {
        crm_provider: a.crm_provider,
        crm_credentials_encrypted: a.crm_credentials_encrypted,
      },
      workspace: {
        crm_provider: ws.crm_provider,
        crm_credentials_encrypted: ws.crm_credentials_encrypted,
      },
      hasCallConfig: Boolean(callConfigRow),
    });

    if (blocked) {
      console.error(`- ${a.name}: BLOCKED — ${blocked}`);
      continue;
    }

    if (dryRun) {
      console.log(`- ${a.name}: would activate (passes all invariants).`);
      continue;
    }

    await bindRetellWebhookForAgentSafe({
      id: a.id,
      retell_agent_id: a.retell_agent_id,
      retell_credentials_encrypted: a.retell_credentials_encrypted,
    });

    const { error } = await db
      .from("agents")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", a.id);
    if (error) {
      console.error(`- ${a.name}: update failed — ${error.message}`);
      continue;
    }
    console.log(`- ${a.name}: ACTIVATED.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
