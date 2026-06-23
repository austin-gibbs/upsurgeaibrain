/**
 * Read-only diagnostic for FUB writeback / Retell webhook configuration.
 * Never prints secrets or API keys — only presence/absence and FUB read results.
 *
 * Usage: set -a && source .env.local && set +a && npx tsx scripts/diagnose-writeback.ts [fubPersonId]
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "@/lib/crypto";
import { FollowUpBossAdapter } from "@/lib/crm/followupboss";
import type { FubCredentials } from "@/lib/crm/types";
import type { RetellCredentials } from "@/lib/retell/client";

const FUB_PERSON_ID = process.argv[2] ?? "97850";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("Missing Supabase env vars");

  console.log("=== Webhook configuration ===");
  console.log("RETELL_WEBHOOK_SECRET:", process.env.RETELL_WEBHOOK_SECRET?.trim() ? "set" : "MISSING");
  console.log(
    "CREDENTIALS_ENCRYPTION_KEY:",
    process.env.CREDENTIALS_ENCRYPTION_KEY?.trim() ? "set" : "MISSING"
  );

  const supabase = createClient(url, serviceKey);

  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, retell_agent_id, retell_credentials_encrypted")
    .not("retell_agent_id", "is", null);

  for (const agent of agents ?? []) {
    let canDecrypt = false;
    let hasWebhookSecret = false;
    if (agent.retell_credentials_encrypted) {
      try {
        const creds = decryptJson<RetellCredentials>(agent.retell_credentials_encrypted);
        canDecrypt = true;
        hasWebhookSecret = Boolean(creds.webhookSecret?.trim());
      } catch {
        canDecrypt = false;
      }
    }
    console.log(
      `Agent "${agent.name}" (${agent.retell_agent_id}): retell_creds=${Boolean(agent.retell_credentials_encrypted)} decrypt_ok=${canDecrypt} webhookSecret=${hasWebhookSecret}`
    );
  }

  console.log("\n=== Call timing (webhook vs reconcile indicator) ===");
  const { data: recent } = await supabase
    .from("calls")
    .select("id, contact_name, dialed_at, completed_at, status")
    .not("dialed_at", "is", null)
    .not("completed_at", "is", null)
    .order("dialed_at", { ascending: false })
    .limit(10);

  for (const c of recent ?? []) {
    const dialed = new Date(c.dialed_at!).getTime();
    const completed = new Date(c.completed_at!).getTime();
    const gapSec = Math.round((completed - dialed) / 1000);
    const path = gapSec < 120 ? "likely-webhook" : "likely-reconcile";
    console.log(
      `${c.contact_name ?? c.id}: gap=${gapSec}s (${path}) status=${c.status}`
    );
  }

  const { count: stuckCount } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true })
    .eq("status", "dialing");

  console.log(`\nStuck in dialing: ${stuckCount ?? 0}`);

  console.log(`\n=== FUB read-only check (person ${FUB_PERSON_ID}) ===`);
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, crm_credentials_encrypted, crm_provider")
    .eq("crm_provider", "followupboss")
    .not("crm_credentials_encrypted", "is", null)
    .limit(1)
    .maybeSingle();

  if (!workspace?.crm_credentials_encrypted) {
    console.log("No FUB workspace with credentials found.");
    return;
  }

  const creds = decryptJson<FubCredentials>(workspace.crm_credentials_encrypted);
  const fub = new FollowUpBossAdapter(creds);

  const person = await fub.getContact(FUB_PERSON_ID);
  console.log("Person found:", Boolean(person), person?.fullName ?? "");

  const notesRes = await fetch(
    `https://api.followupboss.com/v1/notes?personId=${FUB_PERSON_ID}&limit=5&sort=created&direction=desc`,
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${creds.apiKey}:`).toString("base64"),
        Accept: "application/json",
      },
    }
  );
  const notesData = notesRes.ok ? ((await notesRes.json()) as any) : null;
  const notes = notesData?.notes ?? [];
  console.log(`Recent notes (${notes.length}):`);
  for (const n of notes.slice(0, 3)) {
    console.log(`  - ${n.created}: ${String(n.body ?? "").slice(0, 80)}...`);
  }

  const callsRes = await fetch(
    `https://api.followupboss.com/v1/calls?personId=${FUB_PERSON_ID}&limit=5&sort=created&direction=desc`,
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${creds.apiKey}:`).toString("base64"),
        Accept: "application/json",
      },
    }
  );
  const callsData = callsRes.ok ? ((await callsRes.json()) as any) : null;
  const calls = callsData?.calls ?? [];
  console.log(`Recent call logs (${calls.length}):`);
  for (const cl of calls.slice(0, 3)) {
    console.log(
      `  - ${cl.created}: duration=${cl.duration ?? "?"}s recording=${Boolean(cl.recordingUrl)}`
    );
  }

  const tasksRes = await fetch(
    `https://api.followupboss.com/v1/tasks?personId=${FUB_PERSON_ID}&limit=5&sort=created&direction=desc`,
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${creds.apiKey}:`).toString("base64"),
        Accept: "application/json",
      },
    }
  );
  const tasksData = tasksRes.ok ? ((await tasksRes.json()) as any) : null;
  const tasks = tasksData?.tasks ?? [];
  console.log(`Recent tasks (${tasks.length}):`);
  for (const t of tasks.slice(0, 3)) {
    console.log(`  - ${t.created}: ${t.name} (${t.type}) due=${t.dueDate}`);
  }
}

main().catch((e) => {
  console.error("[diagnose-writeback] error:", e.message ?? e);
  process.exit(1);
});
