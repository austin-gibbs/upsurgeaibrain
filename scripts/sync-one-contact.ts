#!/usr/bin/env -S npx tsx
/** One-off: refresh a single contact's phones/tags from FUB into local cache. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { decryptJson } from "../src/lib/crypto";
import { FollowUpBossAdapter } from "../src/lib/crm/followupboss";
import type { Agent, Workspace } from "../src/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadEnvLocal() {
  const envPath = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function argValue(flag: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
}

async function main() {
  loadEnvLocal();
  const contactId = argValue("--contact-id");
  if (!contactId) {
    console.error("Usage: npx tsx scripts/sync-one-contact.ts --contact-id=<uuid>");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    console.error("Missing Supabase env in .env.local");
    process.exit(1);
  }

  const db = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: contact, error: cErr } = await db
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .single();
  if (cErr || !contact) throw new Error(cErr?.message ?? "contact not found");

  const { data: workspace } = await db
    .from("workspaces")
    .select("*")
    .eq("id", contact.workspace_id)
    .single<Workspace>();
  if (!workspace?.crm_credentials_encrypted) throw new Error("workspace missing CRM creds");

  const crm = new FollowUpBossAdapter(
    decryptJson(workspace.crm_credentials_encrypted) as { apiKey: string }
  );
  const fresh = await crm.getContact(contact.crm_contact_id);
  if (!fresh) throw new Error(`FUB person ${contact.crm_contact_id} not found`);

  const { error: uErr } = await db
    .from("contacts")
    .update({
      full_name: fresh.fullName,
      email: fresh.email,
      phones: fresh.phones,
      tags: fresh.tags,
    })
    .eq("id", contactId);
  if (uErr) throw new Error(uErr.message);

  console.log(JSON.stringify({
    contactId,
    fullName: fresh.fullName,
    crmContactId: fresh.id,
    phones: fresh.phones,
    tags: fresh.tags,
  }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
