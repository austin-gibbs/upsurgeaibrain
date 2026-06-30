/**
 * One-time remediation for Nil Patel Realty June 30 poll gaps.
 * Run only after reviewing audit output:
 *   npx tsx scripts/remediate-nil-patel-poll.ts
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const WORKSPACE_ID = "28803e2d-a78d-4377-a718-824c58116151";
const AGENT_ID = "90a9c10c-77a3-470a-92bf-2eb874448d3f";
const ENROLL_TAG = "upsurge.probate.ai";
const POLL_CUTOFF = "2026-06-30 18:00:00+00";

function firstEmbedded<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

  const supabase = createClient(url, key);

  const { data: staleRows } = await supabase
    .from("call_queue_entries")
    .select("id, status, queue_day, contact_id, contacts!inner(updated_at)")
    .eq("agent_id", AGENT_ID)
    .in("status", ["pending", "dialing"])
    .lt("queue_day", "2026-06-30");

  const toDelete = (staleRows ?? []).filter((row) => {
    const c = firstEmbedded(row.contacts);
    return Boolean(c && c.updated_at < POLL_CUTOFF);
  });

  if (toDelete.length > 0) {
    const { error } = await supabase
      .from("call_queue_entries")
      .delete()
      .in(
        "id",
        toDelete.map((r) => r.id)
      );
    if (error) throw error;
    console.log(`Deleted ${toDelete.length} stale queue rows (pre-June 30 poll).`);
  } else {
    console.log("No stale queue rows to delete.");
  }

  const { data: staleContacts } = await supabase
    .from("contacts")
    .select("id, tags")
    .eq("workspace_id", WORKSPACE_ID)
    .contains("tags", [ENROLL_TAG])
    .eq("is_terminal", false)
    .lt("updated_at", POLL_CUTOFF);

  let stripped = 0;
  for (const row of staleContacts ?? []) {
    const nextTags = row.tags.filter((t: string) => t !== ENROLL_TAG);
    if (nextTags.length === row.tags.length) continue;
    const { error } = await supabase.from("contacts").update({ tags: nextTags }).eq("id", row.id);
    if (error) throw error;
    stripped++;
  }
  console.log(`Stripped enroll tag from ${stripped} local contacts not refreshed by June 30 poll.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
