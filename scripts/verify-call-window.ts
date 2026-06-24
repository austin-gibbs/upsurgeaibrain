// =====================================================================
// verify-call-window.ts — READ-ONLY proof that every queued dial for a
// workspace is scheduled inside the calling window.
//
// Does NOT place calls, mutate the queue, or write to the DB. It reads:
//   1. call_queue_entries (Supabase) — the durable scheduled_for per contact
//   2. the BullMQ `outbound-call` queue (Redis) — delayed/waiting dial jobs,
//      whose real fire time is job.timestamp + job.delay
// and checks each scheduled dial time against BOTH bounds enforced at dial:
//   • hard global guard: 09:00–19:00 America/New_York
//   • per-agent window (in the workspace timezone), when configured
//
// Usage:
//   npx tsx scripts/verify-call-window.ts "Nil Patel Realty"
//
// Exit code 0 = every scheduled dial is inside the window. Non-zero = at
// least one is outside (which the runtime guard would still DEFER, never
// dial — see the note printed at the end).
// =====================================================================
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { createServiceClient } from "@/lib/supabase/server";
import { getCallQueue, CALL_QUEUE, type CallJob } from "@/lib/queue/queues";
import { closeRedis } from "@/lib/queue/connection";
import { normalizeHHMM } from "@/lib/hhmm";

const EASTERN_TZ = "America/New_York";
const EASTERN_OPEN = "09:00";
const EASTERN_CLOSE = "19:00"; // exclusive

/** Wall-clock "HH:MM" of an absolute instant in a given IANA timezone. */
function hhmmInTzAt(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/^24:/, "00:");
}

/** Calendar date "YYYY-MM-DD" of an absolute instant in a given IANA timezone. */
function dateInTzAt(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Mirrors evaluateDialWindow, but for an ARBITRARY future instant. */
function checkInstant(
  fireAt: Date,
  workspaceTz: string,
  agentStart?: string | null,
  agentEnd?: string | null
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. Hard global guard: 09:00 (incl) – 19:00 (excl) Eastern.
  const etHHMM = hhmmInTzAt(fireAt, EASTERN_TZ);
  if (etHHMM < EASTERN_OPEN || etHHMM >= EASTERN_CLOSE) {
    reasons.push(`ET ${etHHMM} outside ${EASTERN_OPEN}-${EASTERN_CLOSE}`);
  }

  // 2. Per-agent window (workspace tz), inclusive both ends — matches
  //    withinCallWindow (now >= start && now <= end).
  if (agentStart && agentEnd) {
    const wsHHMM = hhmmInTzAt(fireAt, workspaceTz);
    const start = normalizeHHMM(agentStart);
    const end = normalizeHHMM(agentEnd);
    if (wsHHMM < start || wsHHMM > end) {
      reasons.push(`agent-tz ${wsHHMM} outside ${start}-${end} ${workspaceTz}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

async function main() {
  const workspaceName = process.argv[2] ?? "Nil Patel Realty";
  const supabase = createServiceClient();

  // ── Workspace ──────────────────────────────────────────────────────────────
  const { data: workspace, error: wsErr } = await supabase
    .from("workspaces")
    .select("id, name, timezone")
    .ilike("name", workspaceName)
    .maybeSingle<{ id: string; name: string; timezone: string }>();
  if (wsErr) throw new Error(wsErr.message);
  if (!workspace) throw new Error(`workspace "${workspaceName}" not found`);

  const workspaceTz = workspace.timezone ?? EASTERN_TZ;
  console.log(`\nWorkspace: ${workspace.name}  (tz=${workspaceTz}, id=${workspace.id})`);

  // ── Agents + their configured windows ───────────────────────────────────────
  const { data: agents } = await supabase
    .from("agents")
    .select("id, name")
    .eq("workspace_id", workspace.id)
    .returns<{ id: string; name: string }[]>();
  const agentIds = (agents ?? []).map((a) => a.id);
  const agentName = new Map((agents ?? []).map((a) => [a.id, a.name]));

  const windowByAgent = new Map<string, { start: string | null; end: string | null }>();
  if (agentIds.length) {
    const { data: cfgs } = await supabase
      .from("agent_call_configs")
      .select("agent_id, call_window_start, call_window_end")
      .in("agent_id", agentIds)
      .returns<{ agent_id: string; call_window_start: string | null; call_window_end: string | null }[]>();
    for (const c of cfgs ?? []) {
      windowByAgent.set(c.agent_id, { start: c.call_window_start, end: c.call_window_end });
    }
  }

  for (const a of agents ?? []) {
    const w = windowByAgent.get(a.id);
    console.log(
      `  agent ${a.name}: window ${w?.start ?? "(none)"}-${w?.end ?? "(none)"} ${workspaceTz}  + hard 09:00-19:00 ET`
    );
  }

  let failures = 0;
  let checked = 0;

  // ── Source 1: durable call_queue_entries.scheduled_for ──────────────────────
  const { data: entries } = await supabase
    .from("call_queue_entries")
    .select("agent_id, contact_id, status, scheduled_for")
    .eq("workspace_id", workspace.id)
    .in("status", ["pending", "dialing"])
    .returns<{ agent_id: string; contact_id: string; status: string; scheduled_for: string | null }[]>();

  console.log(`\n[1] call_queue_entries (pending/dialing): ${entries?.length ?? 0} rows`);
  for (const e of entries ?? []) {
    if (!e.scheduled_for) continue; // dialing-now rows may have no future slot
    const fireAt = new Date(e.scheduled_for);
    const w = windowByAgent.get(e.agent_id);
    const r = checkInstant(fireAt, workspaceTz, w?.start, w?.end);
    checked++;
    if (!r.ok) {
      failures++;
      console.log(
        `    ✗ ${agentName.get(e.agent_id) ?? e.agent_id} contact ${e.contact_id} @ ${e.scheduled_for} ` +
          `(${dateInTzAt(fireAt, EASTERN_TZ)} ${hhmmInTzAt(fireAt, EASTERN_TZ)} ET) — ${r.reasons.join("; ")}`
      );
    }
  }

  // ── Source 2: live BullMQ delayed/waiting dial jobs ─────────────────────────
  const queue = getCallQueue();
  const jobs = await queue.getJobs(["delayed", "waiting", "prioritized", "paused"]);
  const ourJobs = jobs.filter((j) => j && agentIds.includes((j.data as CallJob)?.agentId));

  console.log(`\n[2] BullMQ ${CALL_QUEUE} (delayed/waiting): ${ourJobs.length} jobs for this workspace`);
  for (const job of ourJobs) {
    const data = job.data as CallJob;
    if (data.testMode) continue; // test dials intentionally bypass the window
    const delay = (job.delay ?? job.opts?.delay ?? 0) as number;
    const fireAt = new Date((job.timestamp ?? Date.now()) + delay);
    const w = windowByAgent.get(data.agentId);
    const r = checkInstant(fireAt, workspaceTz, w?.start, w?.end);
    checked++;
    if (!r.ok) {
      failures++;
      console.log(
        `    ✗ job ${job.id} ${agentName.get(data.agentId) ?? data.agentId} contact ${data.contactId} ` +
          `fires ${fireAt.toISOString()} (${dateInTzAt(fireAt, EASTERN_TZ)} ${hhmmInTzAt(fireAt, EASTERN_TZ)} ET) — ${r.reasons.join("; ")}`
      );
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  console.log(`\n────────────────────────────────────────────────────────`);
  console.log(`Checked ${checked} scheduled dials across both sources.`);
  if (failures === 0) {
    console.log(`✅ PASS — every scheduled dial lands inside the calling window.`);
  } else {
    console.log(`⚠️  ${failures} scheduled dial(s) fall outside the window AS SCHEDULED.`);
  }
  console.log(
    `\nNote: scheduling is the FIRST line of defense. Even a dial that drifts\n` +
      `outside the window (late poll, long queue, clock crossing 7pm) cannot be\n` +
      `placed: the worker pre-check AND placeCall's authoritative guard both call\n` +
      `evaluateDialWindow BEFORE any Retell call is created, and DEFER it to the\n` +
      `next 9am window instead of dialing. No contact is dropped.`
  );

  await queue.close();
  closeRedis();
  // getRedis() may hold an open handle; force-exit so the script returns.
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[verify-call-window] error:", e);
  closeRedis();
  process.exit(2);
});
