import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createServiceClient } from "@/lib/supabase/server";
import { placeCall } from "@/lib/engine/caller";
import { buildDynamicVariables } from "@/lib/engine/memory";
import { getRetellClientForAgent } from "@/lib/retell/client";
import type { Agent, AgentMemory, Contact } from "@/types";

const AGENT_ID = "90a9c10c-77a3-470a-92bf-2eb874448d3f";
const CONTACT_ID = "232368f0-3ed7-4882-960d-f8ba1c274f3c";
const POLL_MS = 10_000;
const MAX_POLL_MS = 5 * 60_000;

function hasKarate(s: string | null | undefined): boolean {
  return !!s && /karate/i.test(s);
}

function preview(s: string, max = 400): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function extractAgentLinesFromRetell(call: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const obj = call.transcript_object as Array<{ role?: string; content?: string; words?: unknown }> | undefined;
  if (Array.isArray(obj)) {
    for (const u of obj) {
      const role = (u.role ?? "").toLowerCase();
      if (role === "agent" || role === "assistant") {
        if (u.content) lines.push(String(u.content));
      }
    }
  }
  const plain = call.transcript;
  if (typeof plain === "string" && lines.length === 0) {
    // Heuristic: lines starting with Agent:
    for (const line of plain.split("\n")) {
      if (/^\s*agent\s*:/i.test(line)) lines.push(line.replace(/^\s*agent\s*:\s*/i, ""));
    }
    if (lines.length === 0) lines.push(plain);
  }
  return lines;
}

async function getRetellAgentWebhook(agent: Agent, retellAgentId: string): Promise<void> {
  const retell = getRetellClientForAgent(agent);
  const apiKey = (retell as unknown as { apiKey: string }).apiKey;
  const res = await fetch(`https://api.retellai.com/get-agent/${retellAgentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  console.log("\n=== Retell get-agent (webhook URL) ===");
  console.log("HTTP", res.status);
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    console.log("agent_id:", data.agent_id);
    console.log("agent_name:", data.agent_name);
    console.log("webhook_url:", data.webhook_url ?? data.response_engine ?? "(see full keys)");
    const keys = Object.keys(data).filter((k) => /webhook|url/i.test(k));
    for (const k of keys) console.log(`${k}:`, data[k]);
    if (keys.length === 0) {
      console.log("relevant snippet:", preview(JSON.stringify(data), 1200));
    }
  } catch {
    console.log(text.slice(0, 800));
  }
}

async function main() {
  const supabase = createServiceClient();

  console.log("=== Step 2: Contact ===");
  const { data: contact, error: cErr } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", CONTACT_ID)
    .single<Contact>();
  if (cErr || !contact) throw new Error(`contact query failed: ${cErr?.message}`);
  console.log("full_name:", contact.full_name);
  console.log("phones:", contact.phones);
  console.log("attempt_count:", contact.attempt_count);
  console.log("is_terminal:", contact.is_terminal);
  if (contact.is_terminal) {
    console.error("ABORT: contact is terminal");
    process.exit(2);
  }
  const toNumber = contact.phones?.[0];
  if (!toNumber) {
    console.error("ABORT: no phone");
    process.exit(2);
  }

  console.log("\n=== Step 3: agent_memory (before dial) ===");
  const { data: memory } = await supabase
    .from("agent_memory")
    .select("*")
    .eq("agent_id", AGENT_ID)
    .eq("contact_id", CONTACT_ID)
    .maybeSingle<AgentMemory>();
  if (!memory) {
    console.log("(no agent_memory row)");
  } else {
    console.log("call_count:", memory.call_count);
    console.log("memory_summary preview:", preview(memory.summary ?? "", 500));
    console.log("known_facts (facts):", JSON.stringify(memory.facts ?? {}, null, 2));
    console.log("karate in summary?", hasKarate(memory.summary));
    console.log("karate in facts JSON?", hasKarate(JSON.stringify(memory.facts ?? {})));
  }

  const { data: agent } = await supabase.from("agents").select("*").eq("id", AGENT_ID).single<Agent>();
  if (!agent?.retell_agent_id) throw new Error("agent not found or missing retell_agent_id");

  await getRetellAgentWebhook(agent, agent.retell_agent_id);

  const attemptNumber = contact.attempt_count + 1;
  console.log("\n=== Step 5: buildDynamicVariables (before placeCall) ===");
  const dynamicVariables = buildDynamicVariables({
    agent,
    contact,
    memory: memory ?? null,
    attemptNumber,
  });
  console.log(JSON.stringify(dynamicVariables, null, 2));
  console.log("karate in memory_summary?", hasKarate(dynamicVariables.memory_summary));
  console.log("karate in known_facts?", hasKarate(dynamicVariables.known_facts));

  console.log("\n=== Step 6: placeCall ===");
  console.log("toNumber:", toNumber, "attemptNumber:", attemptNumber);
  const { callId, retellCallId } = await placeCall({
    agentId: AGENT_ID,
    contactId: CONTACT_ID,
    toNumber,
    attemptNumber,
  });
  console.log("callId:", callId);
  console.log("retellCallId:", retellCallId);

  const retell = getRetellClientForAgent(agent);
  console.log("\n=== Step 7: Poll Retell get-call (10s, max 5m) ===");
  const started = Date.now();
  let lastStatus = "";
  let finalCall: Record<string, unknown> | null = null;
  while (Date.now() - started < MAX_POLL_MS) {
    const call = (await retell.getCall(retellCallId)) as Record<string, unknown>;
    const status = String(call.call_status ?? "unknown");
    if (status !== lastStatus) {
      console.log(`[${new Date().toISOString()}] call_status=${status}`);
      lastStatus = status;
    }
    if (status === "ended" || status === "error") {
      finalCall = call;
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  if (!finalCall) {
    console.error("TIMEOUT: call did not end within 5 minutes");
    process.exit(3);
  }

  console.log("\n=== Step 8: Transcript analysis ===");
  const agentLines = extractAgentLinesFromRetell(finalCall);
  console.log("Retell call_status:", finalCall.call_status);
  console.log("Retell disconnection_reason:", finalCall.disconnection_reason);
  console.log("\n--- Agent transcript lines (Retell) ---");
  for (const line of agentLines) console.log(line);
  if (agentLines.length === 0) {
    console.log("(no parsed agent lines; raw transcript preview)");
    console.log(preview(String(finalCall.transcript ?? JSON.stringify(finalCall.transcript_object)), 1500));
  }
  const agentMentionedKarate = agentLines.some((l) => hasKarate(l)) ||
    agentLines.join("\n").length === 0 && hasKarate(String(finalCall.transcript ?? ""));

  const { data: callRow } = await supabase.from("calls").select("*").eq("id", callId).single();
  console.log("\n--- Supabase calls row ---");
  console.log("status:", callRow?.status);
  console.log("outcome:", callRow?.outcome);
  console.log("transcript preview:", preview(callRow?.transcript ?? "", 1500));

  console.log("\n=== Step 9: Webhook processed? ===");
  const webhookDone = callRow?.status === "completed";
  console.log("calls.status === 'completed':", webhookDone);

  // Poll a bit for webhook if call ended but not completed yet
  if (!webhookDone && finalCall.call_status === "ended") {
    console.log("Waiting up to 60s for webhook to mark completed…");
    const wStart = Date.now();
    while (Date.now() - wStart < 60_000) {
      await new Promise((r) => setTimeout(r, 5000));
      const { data: row } = await supabase.from("calls").select("status, transcript").eq("id", callId).single();
      if (row?.status === "completed") {
        console.log("Webhook processed; status=completed");
        if (row.transcript) console.log("DB transcript preview:", preview(row.transcript, 1500));
        break;
      }
    }
    const { data: row2 } = await supabase.from("calls").select("status, transcript").eq("id", callId).single();
    console.log("Final calls.status:", row2?.status);
  }

  const dbKarate = hasKarate(callRow?.transcript ?? "");
  const pass = agentMentionedKarate || dbKarate;

  console.log("\n=== Step 10: VERDICT ===");
  console.log("Agent mentioned karate (Retell agent lines):", agentMentionedKarate);
  console.log("Karate anywhere in DB transcript:", dbKarate);
  console.log("RESULT:", pass ? "PASS" : "FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
