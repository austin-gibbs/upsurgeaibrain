#!/usr/bin/env node
/**
 * Audit CRM inheritance for all agents in a workspace (or every workspace).
 *
 * Usage:
 *   node scripts/audit-workspace-crm-inheritance.mjs
 *   node scripts/audit-workspace-crm-inheritance.mjs <workspace-uuid>
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

function audit(agent, workspace) {
  const own = Boolean(agent.crm_provider && agent.crm_credentials_encrypted);
  const ws = Boolean(workspace.crm_provider && workspace.crm_credentials_encrypted);
  const inherits = !own;
  const provider = own
    ? agent.crm_provider
    : ws
      ? workspace.crm_provider
      : agent.crm_provider ?? workspace.crm_provider ?? null;

  let recommendation = null;
  if (own && ws && provider === "highlevel") {
    recommendation =
      "Clear this agent's HighLevel credentials and inherit the workspace connection so OAuth refresh tokens are not duplicated for the same location.";
  } else if (!own && !ws) {
    recommendation =
      "Neither this agent nor its workspace has CRM credentials. Connect CRM before activating.";
  }

  return { inherits, own, ws, provider, recommendation };
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(url, key);
const workspaceId = process.argv[2] ?? null;

let workspacesQuery = db
  .from("workspaces")
  .select("id, name, crm_provider, crm_credentials_encrypted");
if (workspaceId) workspacesQuery = workspacesQuery.eq("id", workspaceId);

const { data: workspaces, error: wsErr } = await workspacesQuery;
if (wsErr) {
  console.error(wsErr.message);
  process.exit(1);
}

if (!workspaces?.length) {
  console.log("No workspaces found.");
  process.exit(0);
}

for (const ws of workspaces) {
  console.log(`\n=== ${ws.name} (${ws.id}) ===`);
  const wsHas = Boolean(ws.crm_provider && ws.crm_credentials_encrypted);
  console.log(
    `Workspace CRM: ${ws.crm_provider ?? "none"}${wsHas ? " (credentials stored)" : " (no credentials)"}`
  );

  const { data: agents, error: agErr } = await db
    .from("agents")
    .select("id, name, crm_provider, crm_credentials_encrypted, status, direction")
    .eq("workspace_id", ws.id)
    .order("created_at", { ascending: true });
  if (agErr) {
    console.error(agErr.message);
    continue;
  }

  for (const agent of agents ?? []) {
    const a = audit(agent, ws);
    const inheritLabel = a.inherits ? "inherits workspace" : "own credentials";
    console.log(
      `  • ${agent.name} [${agent.status}, ${agent.direction}] — ${inheritLabel}, effective ${a.provider ?? "none"}`
    );
    if (a.recommendation) {
      console.log(`    → ${a.recommendation}`);
    }
  }
}

console.log("");
