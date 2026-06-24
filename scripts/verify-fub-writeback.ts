#!/usr/bin/env tsx
// =====================================================================
// Verify FUB real-time writeback: place one Call-now dial and poll until
// the call row finalizes. Reports finalized_by (webhook vs reconcile).
//
// Usage:
//   npx tsx scripts/verify-fub-writeback.ts
//   npx tsx scripts/verify-fub-writeback.ts --agent-id <uuid> --contact-id <uuid>
// =====================================================================
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createServiceClient } from "../src/lib/supabase/server";
import { placeCall } from "../src/lib/engine/caller";
import { getRetellClientForAgent } from "../src/lib/retell/client";

const PROBATE_AGENT_ID = "90a9c10c-77a3-470a-92bf-2eb874448d3f";
const TEST_CONTACT_ID = "232368f0-3ed7-4882-960d-f8ba1c274f3c";
const WEBHOOK_URL =
  `${(process.env.NEXT_PUBLIC_APP_URL || "https://upsurgeprosai.com").replace(/\/+$/, "")}/api/webhooks/retell`;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const agentId = arg("--agent-id") ?? PROBATE_AGENT_ID;
  const contactId = arg("--contact-id") ?? TEST_CONTACT_ID;
  const supabase = createServiceClient();

  const { data: agent } = await supabase.from("agents").select("*").eq("id", agentId).single();
  if (!agent) throw new Error(`agent ${agentId} not found`);
  if (!agent.retell_agent_id) throw new Error("agent missing retell_agent_id");

  const retell = getRetellClientForAgent(agent);
  console.log(`[verify] binding agent-level webhook -> ${WEBHOOK_URL}`);
  await retell.ensureAgentWebhookUrl(agent.retell_agent_id, WEBHOOK_URL);

  const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).single();
  if (!contact) throw new Error(`contact ${contactId} not found`);
  const dialNumber = contact.phones?.[0];
  if (!dialNumber) throw new Error("contact has no phone");

  console.log(
    `[verify] placing test dial to ${contact.full_name ?? contactId} (${dialNumber}), FUB id ${contact.crm_contact_id}`
  );

  const { callId, retellCallId } = await placeCall({
    agentId,
    contactId,
    toNumber: dialNumber,
    attemptNumber: (contact.attempt_count ?? 0) + 1,
    testMode: true,
  });

  console.log(`[verify] call row ${callId}, retell ${retellCallId} — polling for completion…`);

  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const { data: row } = await supabase
      .from("calls")
      .select(
        "status, finalized_by, note_logged, recording_logged, tags_synced, crm_error, completed_at"
      )
      .eq("id", callId)
      .single();

    if (row?.status === "completed") {
      console.log("[verify] completed:", row);
      if (row.finalized_by === "webhook") {
        console.log("[verify] SUCCESS — real-time webhook path");
        process.exit(0);
      }
      if (row.finalized_by === "reconcile") {
        console.warn("[verify] WARN — finalized via reconcile (delayed), not real-time webhook");
        process.exit(row.note_logged && row.tags_synced ? 0 : 1);
      }
      console.warn("[verify] completed but finalized_by is null/unknown");
      process.exit(row.note_logged ? 0 : 1);
    }

    await sleep(5_000);
  }

  console.error("[verify] TIMEOUT — call did not complete within 6 minutes");
  process.exit(1);
}

main().catch((e) => {
  console.error("[verify] fatal:", e);
  process.exit(1);
});
