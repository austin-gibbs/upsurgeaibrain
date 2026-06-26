/**
 * Backfill missing playable HighLevel call recordings from saved Retell payloads.
 *
 * This does NOT re-run full outcome processing and does NOT add duplicate notes.
 * It only creates the Conversations "Call" message with the recording attachment
 * for completed calls where `recording_logged = false`.
 *
 * Usage:
 *   npx tsx scripts/backfill-hl-recordings.ts --agent-id <agentUuid> --dry-run
 *   npx tsx scripts/backfill-hl-recordings.ts --agent-id <agentUuid> --apply
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "@/lib/crypto";
import { getCrmAdapterForAgent } from "@/lib/crm";
import { resolveHighLevelCallProviderId } from "@/lib/crm/highlevel";
import type { Agent, Workspace } from "@/types";

const DEFAULT_AGENT_ID = "3c3110ff-a610-48c2-aa98-f680c8c9b9fc";

type BackfillCall = {
  id: string;
  crm_contact_id: string | null;
  contact_name: string | null;
  to_number: string;
  outcome: string | null;
  in_voicemail: boolean | null;
  completed_at: string | null;
  raw_payload: any;
};

function argValue(name: string): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] ?? null : null;
}

function callStatus(call: BackfillCall): string {
  if (call.in_voicemail || call.outcome === "no_answer_voicemail") return "voicemail";
  if (call.outcome === "failed") return "failed";
  return "completed";
}

function recordingUrl(call: BackfillCall): string | null {
  const url = call.raw_payload?.call?.recording_url;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}

function fromNumber(call: BackfillCall): string {
  const from = call.raw_payload?.call?.from_number;
  return typeof from === "string" ? from : "";
}

function extractMessages(data: any): any[] {
  if (Array.isArray(data?.messages?.messages)) return data.messages.messages;
  if (Array.isArray(data?.messages)) return data.messages;
  return [];
}

function hasRecordingAttachment(message: any, recording: string): boolean {
  return Array.isArray(message?.attachments) && message.attachments.includes(recording);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const agentId = argValue("--agent-id") ?? DEFAULT_AGENT_ID;
  const limit = Number(argValue("--limit") ?? "500");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single<Agent>();
  if (!agent) throw new Error(`agent ${agentId} not found`);

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("*")
    .eq("id", agent.workspace_id)
    .single<Workspace>();
  if (!workspace) throw new Error(`workspace ${agent.workspace_id} not found`);

  const encrypted = agent.crm_credentials_encrypted ?? workspace.crm_credentials_encrypted;
  if (!encrypted) throw new Error("no HighLevel credentials on agent or workspace");
  const creds = decryptJson<{ locationId: string; callProviderId?: string }>(encrypted);
  const providerId = resolveHighLevelCallProviderId(creds.locationId, creds.callProviderId);
  if (!providerId) {
    throw new Error(
      `No HighLevel Call Conversation Provider configured for location ${creds.locationId}`
    );
  }

  const crm = getCrmAdapterForAgent(agent, workspace) as any;

  const { data: calls, error } = await supabase
    .from("calls")
    .select("id, crm_contact_id, contact_name, to_number, outcome, in_voicemail, completed_at, raw_payload")
    .eq("agent_id", agent.id)
    .eq("workspace_id", workspace.id)
    .eq("status", "completed")
    .or("recording_logged.is.null,recording_logged.eq.false")
    .order("completed_at", { ascending: true })
    .limit(2000)
    .returns<BackfillCall[]>();
  if (error) throw error;

  const actionable = (calls ?? [])
    .filter((call) => Boolean(recordingUrl(call)) && Boolean(call.crm_contact_id))
    .slice(0, limit);

  let alreadyPresent = 0;
  let created = 0;
  let failed = 0;

  console.log(
    `[backfill-hl-recordings] agent="${agent.name}" location=${creds.locationId} mode=${apply ? "apply" : "dry-run"} candidates=${actionable.length}`
  );

  for (const call of actionable) {
    const recording = recordingUrl(call)!;
    const crmContactId = call.crm_contact_id;
    if (!crmContactId) continue;

    try {
      const convos = await crm.request(
        `/conversations/search?locationId=${creds.locationId}&contactId=${encodeURIComponent(
          crmContactId
        )}`,
        { headers: { Version: "2021-04-15" } }
      );
      let conversationId = (convos?.conversations ?? [])[0]?.id as string | undefined;

      if (conversationId) {
        const messages = await crm.request(
          `/conversations/${conversationId}/messages?limit=100`,
          { headers: { Version: "2021-04-15" } }
        );
        if (extractMessages(messages).some((m) => hasRecordingAttachment(m, recording))) {
          alreadyPresent += 1;
          if (apply) {
            await supabase.from("calls").update({ recording_logged: true, crm_error: null }).eq("id", call.id);
          }
          console.log(`present ${call.id} ${call.contact_name ?? ""}`.trim());
          continue;
        }
      }

      if (!apply) {
        console.log(`would-create ${call.id} ${call.contact_name ?? ""}`.trim());
        continue;
      }

      if (!conversationId) {
        const createdConversation = await crm.request(
          "/conversations/",
          {
            method: "POST",
            headers: { Version: "2021-04-15" },
            body: JSON.stringify({
              locationId: creds.locationId,
              contactId: crmContactId,
            }),
          }
        );
        conversationId = createdConversation?.conversation?.id ?? createdConversation?.id;
      }
      if (!conversationId) throw new Error("HighLevel returned no conversation id");

      await crm.request(
        "/conversations/messages/outbound",
        {
          method: "POST",
          headers: { Version: "2021-04-15" },
          body: JSON.stringify({
            type: "Call",
            conversationId,
            conversationProviderId: providerId,
            date: call.completed_at ?? new Date().toISOString(),
            call: {
              to: call.to_number,
              from: fromNumber(call),
              status: callStatus(call),
            },
            attachments: [recording],
          }),
        }
      );

      await supabase.from("calls").update({ recording_logged: true, crm_error: null }).eq("id", call.id);
      created += 1;
      console.log(`created ${call.id} ${call.contact_name ?? ""}`.trim());
    } catch (e) {
      failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      if (apply) {
        await supabase
          .from("calls")
          .update({ crm_error: `backfillPlayableCall: ${message}`.slice(0, 2000) })
          .eq("id", call.id);
      }
      console.log(`failed ${call.id}: ${message.slice(0, 300)}`);
    }
  }

  console.log(
    `[backfill-hl-recordings] done present=${alreadyPresent} created=${created} failed=${failed}`
  );
  if (!apply) console.log("Dry run only. Re-run with --apply after provider access is healthy.");
}

main().catch((e) => {
  console.error("[backfill-hl-recordings] error:", e?.message ?? e);
  process.exit(1);
});
