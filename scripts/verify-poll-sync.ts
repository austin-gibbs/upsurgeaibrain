/**
 * Poll enrollment sync audit + controlled verification helpers.
 *
 * Usage:
 *   npx tsx scripts/verify-poll-sync.ts audit <workspaceId> [agentId]
 *   npx tsx scripts/verify-poll-sync.ts e2e-checklist
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (.env.local).
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const WORKSPACE_NIL_PATEL = "28803e2d-a78d-4377-a718-824c58116151";
const AGENT_PROBATE = "90a9c10c-77a3-470a-92bf-2eb874448d3f";
const ENROLL_TAG = "upsurge.probate.ai";

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

  const enrollTag = workspace.enroll_tag ?? ENROLL_TAG;
  const { count: localWithTag } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .contains("tags", [enrollTag]);

  const { data: latestPoll } = await supabase
    .from("poll_runs")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("ran_at", { ascending: false })
    .limit(agentId ? 1 : 5);

  const agentFilter = agentId ?? AGENT_PROBATE;

  const { data: pendingRows } = await supabase
    .from("call_queue_entries")
    .select("id, status, contact_id, contacts!inner(tags)")
    .eq("agent_id", agentFilter)
    .eq("status", "pending");

  const stalePending = (pendingRows ?? []).filter(
    (row) => !embeddedContactTags(row.contacts).includes(enrollTag)
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
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "dialing"]);

  const queuedWithoutTag = (queuedActive ?? []).filter(
    (row) => !embeddedContactTags(row.contacts).includes(enrollTag)
  ).length;

  console.log(`\n=== Poll sync audit: ${workspace.name} ===\n`);
  console.log(`Local contacts with enroll tag "${enrollTag}": ${localWithTag ?? 0}`);
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
    console.log("\nNo poll_runs rows yet (table added in migration 0023).");
  }

  console.log("\nPass criteria:");
  console.log("  - stale pending count should be 0");
  console.log("  - zombie dialing count should be 0");
  console.log("  - local enroll tag count should match latest poll scanned count");
}

function printE2eChecklist() {
  console.log(`
=== Phase 4: Controlled FUB tag scenarios (Nil Patel / Probate) ===

Prerequisites: workspace ${WORKSPACE_NIL_PATEL}, agent ${AGENT_PROBATE}, tag ${ENROLL_TAG}

1. Preserve cadence (still tagged)
   - Pick contact with attempt_count > 0 and next_eligible_on > today
   - Run poll (Ops → Run poll)
   - Expect: not re-queued; attempt_count and next_eligible_on unchanged in DB

2. Remove enroll tag (unenroll)
   - Pick contact with a pending queue row
   - Remove "${ENROLL_TAG}" in FUB
   - Run poll
   - Expect: pending queue row deleted; local tags[] no longer includes enroll tag
   - poll_runs.cancelled >= 1

3. Add enroll tag (new enrollment)
   - Tag a FUB contact not yet in contacts table
   - Run poll
   - Expect: new contacts row (attempt_count=0); queued if eligible

4. Re-add after terminal (known gap)
   - Re-tag a terminal contact in FUB
   - Run poll
   - Expect: contact upserted but is_terminal=true blocks dialing until cleared manually

After each step: npx tsx scripts/verify-poll-sync.ts audit ${WORKSPACE_NIL_PATEL}
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
  process.exit(1);
}
