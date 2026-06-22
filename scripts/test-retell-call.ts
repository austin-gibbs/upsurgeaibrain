// Throwaway dev script: place a single Retell call directly (bypassing the
// queue/eligibility) to generate a fresh signed webhook for debugging.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
import { RetellClient } from "@/lib/retell/client";

async function main() {
  const r = new RetellClient();
  const res = await r.createPhoneCall({
    fromNumber: "+14706483981",
    toNumber: "+14358620247",
    agentId: "agent_fdc9b889f65247ee60df2037a6",
    metadata: { debug: "sig-test" },
  });
  console.log("[test-retell-call] placed:", res);
  process.exit(0);
}

main().catch((e) => {
  console.error("[test-retell-call] error:", e);
  process.exit(1);
});
