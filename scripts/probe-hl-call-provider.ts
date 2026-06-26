/**
 * Probe HighLevel for conversation provider / channel info using agent creds.
 * Read-only; never prints tokens.
 *
 * Usage:
 *   set -a && source .env.local && set +a && npx tsx scripts/probe-hl-call-provider.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "@/lib/crypto";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { resolveHighLevelCallProviderId } from "@/lib/crm/highlevel";
import type { Agent, Workspace } from "@/types";

const AGENT_ID = "3c3110ff-a610-48c2-aa98-f680c8c9b9fc";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");

  console.log(`HIGHLEVEL_CALL_PROVIDER_IDS env: ${process.env.HIGHLEVEL_CALL_PROVIDER_IDS?.trim() ? "set" : "MISSING"}`);
  console.log(`HIGHLEVEL_CALL_PROVIDER_ID fallback env: ${process.env.HIGHLEVEL_CALL_PROVIDER_ID?.trim() ? "set" : "MISSING"}`);

  const supabase = createClient(url, serviceKey);
  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", AGENT_ID)
    .single<Agent>();
  if (!agent) throw new Error("agent not found");

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", agent.workspace_id)
    .single<Workspace>();
  if (!workspace) throw new Error("workspace not found");

  const encrypted = agent.crm_credentials_encrypted ?? workspace.crm_credentials_encrypted;
  if (!encrypted) throw new Error("no HL credentials on agent or workspace");
  const creds = decryptJson<{ locationId: string; accessToken: string; callProviderId?: string }>(encrypted);
  console.log(`Agent: ${agent.name}`);
  console.log(`Location ID: ${creds.locationId}`);
  console.log(
    `Resolved call provider: ${
      resolveHighLevelCallProviderId(creds.locationId, creds.callProviderId) ? "set" : "MISSING"
    }`
  );
  console.log(`CRM status: ${agent.crm_status ?? "connected (null)"}`);

  const crm = getCrmAdapterForAgent(agent, workspace) as any;
  const ok = await crm.verifyCredentials();
  console.log(`verifyCredentials: ${ok ? "OK" : "FAILED (re-OAuth likely needed)"}`);
  if (!ok) return;

  // Decode scopes from JWT (no secret printed)
  try {
    const payload = JSON.parse(
      Buffer.from(String(creds.accessToken).split(".")[1], "base64").toString("utf8")
    );
    const scopes: string[] = payload?.oauthMeta?.scopes ?? payload?.scope?.split?.(" ") ?? [];
    const convo = scopes.filter((s) => s.startsWith("conversations"));
    console.log(`Conversation scopes (${convo.length}): ${JSON.stringify(convo)}`);
  } catch {
    console.log("(could not decode token scopes)");
  }

  const paths = [
    `/locations/${creds.locationId}`,
    `/locations/${creds.locationId}/conversation-channels?type=Call`,
    `/locations/${creds.locationId}/conversation-channels?type=SMS`,
  ];
  for (const path of paths) {
    try {
      const data = await crm.request(path);
      console.log(`\nGET ${path} -> OK`);
      console.log(JSON.stringify(data, null, 2).slice(0, 1500));
    } catch (e) {
      console.log(`\nGET ${path} -> ${(e as Error).message.slice(0, 300)}`);
    }
  }
}

main().catch((e) => {
  console.error("[probe-hl-call-provider]", e?.message ?? e);
  process.exit(1);
});
