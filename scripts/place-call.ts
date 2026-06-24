// Throwaway dev script: run the engine's placeCall directly for one contact,
// bypassing the queue's per-day idempotency so we can re-trace a live call +
// its call_analyzed webhook. Usage:
//   npx tsx scripts/place-call.ts <agentId> <contactId> <toNumber> <attempt> [test]
// Pass "test" as the 5th arg to bypass the call-window guard (operator-initiated
// end-to-end check). Write-back still runs fully because the contact is real.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { placeCall } from "@/lib/engine/caller";

async function main() {
  const [agentId, contactId, toNumber, attempt, mode] = process.argv.slice(2);
  if (!agentId || !contactId || !toNumber) {
    throw new Error("usage: tsx scripts/place-call.ts <agentId> <contactId> <toNumber> <attempt> [test]");
  }
  const res = await placeCall({
    agentId,
    contactId,
    toNumber,
    attemptNumber: Number(attempt ?? 1),
    testMode: mode === "test",
  });
  console.log("[place-call] result:", res);
  process.exit(0);
}

main().catch((e) => {
  console.error("[place-call] error:", e);
  process.exit(1);
});
