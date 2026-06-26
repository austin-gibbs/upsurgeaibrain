/**
 * Read-only HighLevel writeback diagnostic. Fetches what is ACTUALLY on a
 * contact in HighLevel (notes, tags, opportunities) so we can confirm whether
 * the engine's note/recording/tag writes are landing where the client looks.
 *
 * Never prints tokens — only presence + HL read results.
 *
 * Usage:
 *   set -a && source .env.local && set +a && npx tsx scripts/diagnose-hl-writeback.ts <ourContactUuid>
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "@/lib/crypto";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { resolveHighLevelCallProviderId } from "@/lib/crm/highlevel";
import type { Agent, Workspace, Contact } from "@/types";

const CONTACT_UUID = process.argv[2] ?? "c353f465-4527-479d-ae49-8a9a853b56d7";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");
  const supabase = createClient(url, serviceKey);

  const { data: contact } = await supabase
    .from("contacts").select("*").eq("id", CONTACT_UUID).single<Contact>();
  if (!contact) throw new Error(`contact ${CONTACT_UUID} not found`);
  console.log(`Contact: ${contact.full_name} crm_contact_id=${contact.crm_contact_id}`);
  console.log(`Local tags: ${JSON.stringify(contact.tags)}`);

  // Find the outbound HighLevel agent in this workspace (per-agent creds first).
  const { data: agents } = await supabase
    .from("agents").select("*")
    .eq("workspace_id", contact.workspace_id)
    .returns<Agent[]>();
  const agent = (agents ?? []).find(
    (a) => a.crm_provider === "highlevel" && a.crm_credentials_encrypted
  ) ?? (agents ?? [])[0];
  if (!agent) throw new Error("no agent found in workspace");
  console.log(`Agent: "${agent.name}" provider=${agent.crm_provider ?? "(workspace)"}`);

  const { data: workspace } = await supabase
    .from("workspaces").select("*").eq("id", contact.workspace_id).single<Workspace>();
  if (!workspace) throw new Error("workspace not found");

  // Decrypt just to surface the locationId (NOT the token) so we can confirm
  // writes target the same sub-account the client is viewing.
  const encrypted = agent.crm_credentials_encrypted ?? workspace.crm_credentials_encrypted;
  if (!encrypted) throw new Error("no HighLevel credentials on agent or workspace");
  const creds = decryptJson<any>(encrypted);
  console.log(`HighLevel locationId: ${creds.locationId}`);
  console.log(
    `Resolved call provider: ${
      resolveHighLevelCallProviderId(creds.locationId, creds.callProviderId) ? "set" : "MISSING"
    }`
  );

  // Decode the (JWT) access token payload to surface GRANTED scopes — this tells
  // us whether a reconnect is needed for conversations call logging. No secret
  // is printed; only the scope list.
  try {
    const payload = JSON.parse(
      Buffer.from(String(creds.accessToken).split(".")[1], "base64").toString("utf8")
    );
    const scopes: string[] = payload?.oauthMeta?.scopes ?? payload?.scope?.split?.(" ") ?? [];
    const convoScopes = scopes.filter((s) => s.startsWith("conversations"));
    console.log(`Granted scopes (${scopes.length}); conversations: ${JSON.stringify(convoScopes)}`);
    console.log(`HIGHLEVEL_CALL_PROVIDER_IDS env: ${process.env.HIGHLEVEL_CALL_PROVIDER_IDS?.trim() ? "set" : "MISSING"}`);
    console.log(`HIGHLEVEL_CALL_PROVIDER_ID fallback env: ${process.env.HIGHLEVEL_CALL_PROVIDER_ID?.trim() ? "set" : "MISSING"}`);
  } catch {
    console.log("(could not decode token scopes)");
  }

  const crm = getCrmAdapterForAgent(agent, workspace) as any;

  // Reach the private request() via the contact fetch path to confirm auth,
  // then hit the notes endpoint directly with the (possibly refreshed) token.
  const fetched = await crm.getContact(contact.crm_contact_id);
  console.log(`\nHL getContact -> found=${Boolean(fetched)} name=${fetched?.fullName ?? ""}`);
  console.log(`HL tags on contact: ${JSON.stringify(fetched?.tags ?? [])}`);

  // Raw reads using the adapter's authenticated request (private, but reachable).
  const notes = await crm.request(`/contacts/${contact.crm_contact_id}/notes`);
  const noteList: any[] = notes?.notes ?? [];
  console.log(`\nNotes on contact (${noteList.length}):`);
  for (const n of noteList.slice(0, 3)) {
    const body = String(n.body ?? "");
    console.log(`  --- note [${n.id}] ${n.dateAdded ?? n.createdAt ?? "?"} ---`);
    console.log(body.split("\n").map((l) => `    ${l}`).join("\n"));
    console.log(`    >> contains "Recording:" = ${body.includes("Recording:")}`);
  }

  try {
    const opps = await crm.request(
      `/opportunities/search?location_id=${creds.locationId}&contact_id=${encodeURIComponent(contact.crm_contact_id)}`
    );
    const oppList: any[] = opps?.opportunities ?? [];
    console.log(`\nOpportunities (${oppList.length}):`);
    for (const o of oppList) {
      console.log(`  - [${o.id}] pipeline=${o.pipelineId} stage=${o.pipelineStageId ?? o.stageId} status=${o.status} name=${o.name}`);
    }
  } catch (e) {
    console.log(`\nOpportunities read failed: ${(e as Error).message}`);
  }

  // Playable call entries live in the contact's conversation as TYPE_CALL
  // messages. List them so we can confirm the new call-logging path landed.
  try {
    const convos = await crm.request(
      `/conversations/search?locationId=${creds.locationId}&contactId=${encodeURIComponent(contact.crm_contact_id)}`,
      { headers: { Version: "2021-04-15" } }
    );
    const convo = (convos?.conversations ?? [])[0];
    console.log(`\nConversation: ${convo?.id ?? "(none)"}`);
    if (convo?.id) {
      const msgs = await crm.request(
        `/conversations/${convo.id}/messages?type=TYPE_CALL&limit=10`,
        { headers: { Version: "2021-04-15" } }
      );
      const list: any[] = msgs?.messages?.messages ?? msgs?.messages ?? [];
      console.log(`Call messages in conversation (${list.length}):`);
      for (const m of list.slice(0, 5)) {
        console.log(`  - [${m.id}] ${m.dateAdded ?? "?"} type=${m.messageType ?? m.type} status=${m.status ?? "?"}`);
      }
    }
  } catch (e) {
    console.log(`\nConversation read failed: ${(e as Error).message}`);
  }
}

main().catch((e) => {
  console.error("[diagnose-hl-writeback] error:", e?.message ?? e);
  process.exit(1);
});
