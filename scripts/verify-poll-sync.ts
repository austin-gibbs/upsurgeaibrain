/**
 * Poll enrollment sync audit + controlled verification helpers.
 *
 * Usage:
 *   npx tsx scripts/verify-poll-sync.ts audit <workspaceId> [agentId]
 *   npx tsx scripts/verify-poll-sync.ts e2e-checklist
 *
 * Prefer `npx tsx scripts/poll-doctor.ts [workspaceId]` for a full
 * multi-agent polling health report (tags, windows, coverage, heartbeat).
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (.env.local).
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { resolveDoctorEnrollTag } from "@/lib/engine/poll-doctor";
import { contactHasEnrollTag } from "@/lib/agents/enroll-tag";

const WORKSPACE_NIL_PATEL = "28803e2d-a78d-4377-a718-824c58116151";
const AGENT_PROBATE = "90a9c10c-77a3-470a-92bf-2eb874448d3f";
const AGENT_CIRCLE = "fafbdf14-5a00-49e2-90ac-bb2064aa5d37";

function firstEmbedded<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function embeddedContactTags(contact: { tags: string[] } | { tags: string[] }[] | null | undefined): string[] {
  return firstEmbedded(contact)?.tags ?? [];
}

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

async function audit(workspaceId: string, agentId?: string) {
  const supabase = db();

  const { data: workspace } = await supabase
    .from("workspaces")
    .select("id, name, enroll_tag")
    .eq("id", workspaceId)
    .single();
  if (!workspace) throw new Error("workspace not found");

  const agentFilter = agentId ?? AGENT_PROBATE;

  const { data: agent } = await supabase
    .from("agents")
    .select("id, name, enroll_tag")
    .eq("id", agentFilter)
    .maybeSingle();

  // Prefer the agent's enroll tag; fall back to workspace — never hardcode probate.
  const enrollTag = resolveDoctorEnrollTag(
    agent?.enroll_tag,
    workspace.enroll_tag
  );

  const { data: allContacts } = await supabase
    .from("contacts")
    .select("id, tags")
    .eq("workspace_id", workspaceId);

  const localWithTag = (allContacts ?? []).filter((c) =>
    contactHasEnrollTag(c.tags, enrollTag)
  ).length;

  const { data: latestPoll } = await supabase
    .from("poll_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("agent_id", agentFilter)
    .order("ran_at", { ascending: false })
    .limit(5);

  const { data: pendingRows } = await supabase
    .from("call_queue_entries")
    .select("id, status, contact_id, contacts!inner(tags)")
    .eq("agent_id", agentFilter)
    .eq("status", "pending");

  const stalePending = (pendingRows ?? []).filter(
    (row) => !contactHasEnrollTag(embeddedContactTags(row.contacts), enrollTag)
  ).length;

  const { data: zombieDialing } = await supabase
    .from("call_queue_entries")
    .select("id, queue_day, started_at")
    .eq("agent_id", agentFilter)
    .eq("status", "dialing")
    .lt("started_at", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString());

  const { data: queuedActive } = await supabase
    .from("call_queue_entries")
    .select("id, contacts!inner(tags)")
    .eq("agent_id", agentFilter)
    .in("status", ["pending", "dialing"]);

  const queuedWithoutTag = (queuedActive ?? []).filter(
    (row) => !contactHasEnrollTag(embeddedContactTags(row.contacts), enrollTag)
  ).length;

  console.log(`\n=== Poll sync audit: ${workspace.name} ===\n`);
  console.log(
    `Agent: ${agent?.name ?? agentFilter} enroll_tag="${enrollTag}"`
  );
  console.log(`Local contacts with enroll tag: ${localWithTag}`);
  console.log(`Stale pending (queued but missing local enroll tag): ${stalePending}`);
  console.log(
    `Zombie dialing rows (>4h in dialing): ${Array.isArray(zombieDialing) ? zombieDialing.length : 0}`
  );
  console.log(`Queued without enroll tag: ${queuedWithoutTag}`);

  if (latestPoll?.length) {
    console.log("\nRecent poll runs:");
    for (const run of latestPoll) {
      console.log(
        `  ${run.ran_at} agent=${run.agent_id.slice(0, 8)}… scanned=${run.scanned} eligible=${run.eligible} enqueued=${run.enqueued} cancelled=${run.cancelled} tags_stripped=${run.tags_stripped} trigger=${run.trigger_source}${run.skipped_reason ? ` skip=${run.skipped_reason}` : ""}`
      );
    }
  } else {
    console.log("\nNo poll_runs rows yet for this agent.");
  }

  console.log("\nPass criteria:");
  console.log("  - stale pending count should be 0");
  console.log("  - zombie dialing count should be 0");
  console.log("  - local enroll tag count should match latest poll scanned count");
  console.log(
    `\nTip: npx tsx scripts/poll-doctor.ts ${workspaceId} for full multi-agent health.`
  );
}

function printE2eChecklist() {
  console.log(`
=== Phase 4: Controlled FUB tag scenarios ===

Prerequisites:
  workspace ${WORKSPACE_NIL_PATEL}
  Probate agent ${AGENT_PROBATE} tag upsurge.probate.ai
  Circle agent ${AGENT_CIRCLE} tag upsurge.circleprospecting.ai

1. Preserve cadence (still tagged)
   - Pick contact with attempt_count > 0 and next_eligible_on > today
   - Run poll (Ops → Run poll)
   - Expect: not re-queued; attempt_count and next_eligible_on unchanged in DB

2. Remove enroll tag (unenroll)
   - Pick contact with a pending queue row
   - Remove the agent's enroll tag in FUB
   - Run poll
   - Expect: pending queue row deleted; local tags[] no longer includes enroll tag
   - poll_runs.cancelled >= 1

3. Add enroll tag (new enrollment)
   - Tag a FUB contact not yet in contacts table with the agent's enroll tag
   - Run poll
   - Expect: new contacts row (attempt_count=0); queued if eligible

4. Re-add after terminal (known gap)
   - Re-tag a terminal contact in FUB
   - Run poll
   - Expect: contact upserted but is_terminal=true blocks dialing until cleared manually

After each step:
  npx tsx scripts/verify-poll-sync.ts audit ${WORKSPACE_NIL_PATEL} <agentId>
  npx tsx scripts/poll-doctor.ts ${WORKSPACE_NIL_PATEL}
`);
}

const [cmd, arg1] = process.argv.slice(2);
if (cmd === "audit") {
  audit(arg1 ?? WORKSPACE_NIL_PATEL, process.argv[3]).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === "e2e-checklist") {
  printE2eChecklist();
} else {
  console.log("Usage: verify-poll-sync.ts audit [workspaceId] [agentId] | e2e-checklist");
  console.log("       Prefer: npx tsx scripts/poll-doctor.ts [workspaceId]");
  process.exit(1);
}
