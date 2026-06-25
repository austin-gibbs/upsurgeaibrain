#!/usr/bin/env node
/**
 * Clear per-agent CRM credentials so the agent inherits the workspace connection.
 * Usage: npx tsx scripts/inherit-workspace-crm-for-agent.mjs <agent-id>
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const agentId = process.argv[2];
if (!agentId) {
  console.error("Usage: npx tsx scripts/inherit-workspace-crm-for-agent.mjs <agent-id>");
  process.exit(1);
}

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: agent, error: agErr } = await db
    .from("agents")
    .select("id, name, workspace_id, crm_provider, crm_credentials_encrypted")
    .eq("id", agentId)
    .single();
  if (agErr || !agent) throw new Error(agErr?.message ?? "agent not found");

  const { data: ws, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, crm_provider, crm_credentials_encrypted")
    .eq("id", agent.workspace_id)
    .single();
  if (wsErr || !ws) throw new Error(wsErr?.message ?? "workspace not found");
  if (!ws.crm_credentials_encrypted) {
    throw new Error("Workspace has no CRM credentials to inherit");
  }

  const hadOwn = Boolean(agent.crm_provider && agent.crm_credentials_encrypted);
  if (!hadOwn) {
    console.log(JSON.stringify({ ok: true, agent: agent.name, alreadyInheriting: true }));
    return;
  }

  const { error: updErr } = await db
    .from("agents")
    .update({
      crm_provider: null,
      crm_credentials_encrypted: null,
      crm_status: null,
    })
    .eq("id", agentId);
  if (updErr) throw new Error(updErr.message);

  console.log(
    JSON.stringify(
      {
        ok: true,
        agent: agent.name,
        workspace: ws.name,
        message: "Agent now inherits workspace CRM credentials.",
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
