#!/usr/bin/env node
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "../src/lib/crypto.ts";
import { buildAdapter } from "../src/lib/crm/index.ts";

dotenv.config({ path: ".env.local" });

const workspaceId = process.argv[2];
if (!workspaceId) {
  console.error("Usage: npx tsx scripts/verify-workspace-crm.mjs <workspace-id>");
  process.exit(1);
}

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: ws, error } = await db
    .from("workspaces")
    .select("id, name, crm_provider, crm_credentials_encrypted, crm_status")
    .eq("id", workspaceId)
    .single();
  if (error || !ws) throw new Error(error?.message ?? "workspace missing");
  if (!ws.crm_credentials_encrypted) throw new Error("workspace has no CRM credentials");

  const creds = decryptJson(ws.crm_credentials_encrypted);
  const adapter = buildAdapter(ws.crm_provider, creds);
  const ok = await adapter.verifyCredentials();

  console.log(
    JSON.stringify(
      {
        workspace: ws.name,
        provider: ws.crm_provider,
        crm_status: ws.crm_status,
        verifyOk: ok,
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
