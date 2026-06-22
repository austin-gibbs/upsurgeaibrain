// Throwaway dev script: invoke pollAgent directly for one agent and print the
// PollResult. Used to dry-run / trace the engine without waiting for the
// scheduler. Run: npx tsx scripts/trigger-poll.ts <agentId>
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { pollAgent } from "@/lib/engine/poller";

async function main() {
  const agentId = process.argv[2];
  if (!agentId) throw new Error("usage: tsx scripts/trigger-poll.ts <agentId>");
  const result = await pollAgent(agentId);
  console.log("[trigger-poll] result:", JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error("[trigger-poll] error:", e);
  process.exit(1);
});
