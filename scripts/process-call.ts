// Dev script: fetch a Retell call and run processRetellWebhook locally.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { RetellClient } from "@/lib/retell/client";
import { processRetellWebhook } from "@/lib/engine/process-outcome";

async function main() {
  const retellCallId = process.argv[2];
  if (!retellCallId) throw new Error("usage: tsx scripts/process-call.ts <retellCallId>");
  const retell = new RetellClient();
  const call = await retell.getCall(retellCallId);
  const result = await processRetellWebhook({ event: "call_analyzed", call });
  console.log("[process-call]", result);
  process.exit(0);
}

main().catch((e) => {
  console.error("[process-call] error:", e);
  process.exit(1);
});
