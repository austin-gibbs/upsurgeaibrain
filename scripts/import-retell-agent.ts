#!/usr/bin/env -S npx tsx
/**
 * Attach an agent that ALREADY EXISTS in a client's Retell account to a
 * workspace in the app.
 *
 * `provision-agent.ts` authors a brand-new Retell agent; there was no path for
 * an agent the client built in Retell themselves. Those agents are invisible
 * everywhere in the app — including the "Applies to" picker in the automations
 * console — because every picker is driven by the `agents` table.
 *
 * The Retell API key is reused from a sibling agent in the same workspace
 * (override with --api-key). Call/task configs are created from schema
 * defaults; for an outbound import, review the call window + cadence in the UI
 * afterwards.
 *
 * The agent's Retell webhook_url is left ALONE by default. Retell allows one
 * webhook per agent, so rebinding it to the app silently steals delivery from
 * whatever the client points it at today (HighLevel, Make, Zapier...). Pass
 * --bind-webhook only when the app is meant to own post-call delivery — that
 * is what post-call automations and CRM writeback need.
 *
 * Requires in .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * CREDENTIALS_ENCRYPTION_KEY.
 *
 * Usage:
 *   npx tsx scripts/import-retell-agent.ts \
 *     --workspace="United Real Estate Experts" \
 *     --retell-agent-id=agent_xxx --direction=inbound [--name="..."] \
 *     [--from-number=+14235550123] [--activate] [--bind-webhook] [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { encryptJson, decryptJson } from "../src/lib/crypto";
import { callConfigSchema, taskConfigSchema } from "../src/lib/validation";
import { validateAgentActivation } from "../src/lib/agents/activation";
import type { AgentEnrollTagRow } from "../src/lib/agents/enroll-tag";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

type RetellCreds = { apiKey: string; webhookSecret?: string };

async function main() {
  loadEnvLocal();

  const workspaceName = argValue("--workspace");
  const retellAgentId = argValue("--retell-agent-id");
  const direction = argValue("--direction");
  const overrideName = argValue("--name");
  const fromNumber = argValue("--from-number") ?? null;
  const overrideApiKey = argValue("--api-key");
  const activate = hasFlag("--activate");
  const bindWebhook = hasFlag("--bind-webhook");
  const dryRun = hasFlag("--dry-run");

  if (!workspaceName || !retellAgentId || (direction !== "inbound" && direction !== "outbound")) {
    fail(
      'Usage: npx tsx scripts/import-retell-agent.ts --workspace="Name" ' +
        "--retell-agent-id=agent_xxx --direction=inbound|outbound"
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) fail("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: workspace, error: wsErr } = await db
    .from("workspaces")
    .select("id, name, enroll_tag, crm_provider, crm_credentials_encrypted")
    .eq("name", workspaceName)
    .maybeSingle<{
      id: string;
      name: string;
      enroll_tag: string;
      crm_provider: string | null;
      crm_credentials_encrypted: string | null;
    }>();
  if (wsErr) fail(`workspace lookup failed: ${wsErr.message}`);
  if (!workspace) fail(`No workspace named "${workspaceName}".`);

  // Importing the same Retell agent twice would give the engine two rows to
  // resolve for one inbound call, so treat an existing row as done.
  const { data: dupe } = await db
    .from("agents")
    .select("id, name, workspace_id")
    .eq("retell_agent_id", retellAgentId)
    .maybeSingle<{ id: string; name: string; workspace_id: string }>();
  if (dupe) {
    console.log(
      `Already imported: "${dupe.name}" (${dupe.id})` +
        (dupe.workspace_id === workspace.id ? "" : " — in a DIFFERENT workspace")
    );
    return;
  }

  const { data: siblings } = await db
    .from("agents")
    .select("id, name, direction, enroll_tag, retell_credentials_encrypted")
    .eq("workspace_id", workspace.id)
    .returns<
      (AgentEnrollTagRow & { name: string; retell_credentials_encrypted: string | null })[]
    >();

  let creds: RetellCreds | null = overrideApiKey ? { apiKey: overrideApiKey } : null;
  if (!creds) {
    for (const sibling of siblings ?? []) {
      if (!sibling.retell_credentials_encrypted) continue;
      creds = decryptJson<RetellCreds>(sibling.retell_credentials_encrypted);
      console.log(`Using the Retell key stored on "${sibling.name}".`);
      break;
    }
  }
  if (!creds?.apiKey) {
    fail("No Retell API key found on any agent in this workspace — pass --api-key=<key>.");
  }

  const res = await fetch(`${RETELL_BASE}/get-agent/${retellAgentId}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
  });
  if (!res.ok) {
    fail(
      `Retell get-agent ${res.status}: ${await res.text()}\n` +
        "The key in use may belong to a different Retell account — pass --api-key=<key>."
    );
  }
  const retellAgent = (await res.json()) as { agent_name?: string; webhook_url?: string | null };
  const name = overrideName ?? retellAgent.agent_name ?? retellAgentId;
  const appWebhook = `${(process.env.NEXT_PUBLIC_APP_URL || "https://upsurgeprosai.com").replace(/\/+$/, "")}/api/webhooks/retell`;

  console.log(
    JSON.stringify(
      {
        workspace: workspace.name,
        name,
        direction,
        retellAgentId,
        fromNumber,
        retellWebhookUrl: retellAgent.webhook_url ?? null,
        activate,
        bindWebhook,
      },
      null,
      2
    )
  );
  if (dryRun) {
    console.log("--dry-run: nothing written.");
    return;
  }

  const { data: agent, error: agErr } = await db
    .from("agents")
    .insert({
      workspace_id: workspace.id,
      name,
      direction,
      enroll_tag: null,
      retell_agent_id: retellAgentId,
      retell_from_number: fromNumber,
      objective: null,
      // Inherit the workspace CRM connection, like its peers.
      crm_provider: null,
      crm_credentials_encrypted: null,
      retell_credentials_encrypted: encryptJson({
        apiKey: creds.apiKey,
        ...(creds.webhookSecret ? { webhookSecret: creds.webhookSecret } : {}),
      }),
      status: "draft",
    })
    .select("id, retell_credentials_encrypted")
    .single<{ id: string; retell_credentials_encrypted: string }>();
  if (agErr || !agent) fail(`failed to create agent: ${agErr?.message}`);

  const { error: ccErr } = await db
    .from("agent_call_configs")
    .insert({ agent_id: agent.id, ...callConfigSchema.parse({}) });
  if (ccErr) fail(`agent created (${agent.id}) but call config failed: ${ccErr.message}`);
  const { error: tcErr } = await db
    .from("agent_task_configs")
    .insert({ agent_id: agent.id, ...taskConfigSchema.parse({}) });
  if (tcErr) fail(`agent created (${agent.id}) but task config failed: ${tcErr.message}`);

  if (bindWebhook) {
    const patch = await fetch(`${RETELL_BASE}/update-agent/${retellAgentId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        webhook_url: appWebhook,
        webhook_events: ["call_started", "call_ended", "call_analyzed"],
      }),
    });
    if (!patch.ok) {
      console.warn(`Retell update-agent ${patch.status}: ${await patch.text()}`);
    } else {
      await fetch(`${RETELL_BASE}/publish-agent/${retellAgentId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.apiKey}` },
      });
      console.log(`Retell webhook rebound to ${appWebhook} and published.`);
    }
  }

  let status = "draft";
  if (activate) {
    const blocked = validateAgentActivation({
      agentId: agent.id,
      direction,
      enrollTag: null,
      retellAgentId,
      retellFromNumber: fromNumber,
      retellCredentialsEncrypted: agent.retell_credentials_encrypted,
      workspaceEnrollTag: workspace.enroll_tag,
      existingAgents: siblings ?? [],
      agent: { crm_provider: null, crm_credentials_encrypted: null },
      workspace: {
        crm_provider: workspace.crm_provider as "followupboss" | "highlevel" | null,
        crm_credentials_encrypted: workspace.crm_credentials_encrypted,
      },
      hasCallConfig: true,
    });
    if (blocked) {
      console.log(`Left as draft — ${blocked}`);
    } else {
      const { error } = await db.from("agents").update({ status: "active" }).eq("id", agent.id);
      if (error) fail(`agent created (${agent.id}) but activation failed: ${error.message}`);
      status = "active";
    }
  }

  console.log(`Imported "${name}" as ${status} (${agent.id}).`);
  if (!bindWebhook && retellAgent.webhook_url !== appWebhook) {
    console.log(
      `NOTE: this Retell agent still posts call events to ${retellAgent.webhook_url ?? "(none)"}, ` +
        "so the app will not see its calls and automations for it will never fire. " +
        "Re-run with --bind-webhook once the app should own delivery."
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
