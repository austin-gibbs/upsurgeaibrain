#!/usr/bin/env node
// =====================================================================
// add-link-fields-all-agents.mjs
//
// Adds the two post-call-analysis fields the automation engine reads —
//   link_requested (boolean)  "Did the caller ask for a link to be sent?"
//   link_type      (string)   which link, e.g. buyer_guide / seller_guide
// — to EVERY agent's LLM in EVERY Retell workspace listed in retell_config.json.
//
// Why the LLM, not the agent: post_call_analysis_data lives on the Retell LLM
// object and is REPLACE-ALL. This script GETs the current array, appends the two
// fields (only if missing — idempotent), PATCHes the LLM, then PUBLISHES the agent
// (publish snapshots agent + referenced LLM together), then verifies.
//
// SAFETY:
//  - Dry-run by default. Prints exactly what it WOULD change. Pass --apply to write.
//  - Backs up each LLM's current post_call_analysis_data to ./retell-backups/ before patch.
//  - Skips any LLM that already has link_requested (safe to re-run).
//  - Dedupes workspaces that share the same api_key (e.g. Best HVAC == UpSurge Multiple).
//  - Never prints API keys.
//
// USAGE (run on your Mac where you have the keys + network — e.g. Cursor terminal):
//   node scripts/add-link-fields-all-agents.mjs --config "/ABSOLUTE/PATH/retell_config.json"            # dry run
//   node scripts/add-link-fields-all-agents.mjs --config "/ABSOLUTE/PATH/retell_config.json" --apply     # execute
//   add --only "Real Estate Growth Partner"  to limit to one workspace (pilot first!)
// =====================================================================

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://api.retellai.com";

// ---- the two fields we add ------------------------------------------------
const LINK_FIELDS = [
  {
    type: "boolean",
    name: "link_requested",
    description:
      "True if the caller asked for a link, guide, or information to be sent to them (e.g. a buyer/seller guide, a home valuation, or a web page). False otherwise.",
  },
  {
    type: "string",
    name: "link_type",
    description:
      "If link_requested is true, a short snake_case identifier for which link the caller wanted, matching this client's link map (e.g. buyer_guide, seller_guide, home_valuation). Leave blank if no link was requested.",
  },
];

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const CONFIG_PATH = getArg("--config");
const ONLY = getArg("--only"); // optional workspace-name filter

if (!CONFIG_PATH) {
  console.error("ERROR: pass --config <path to retell_config.json>");
  process.exit(1);
}

// ---- normalize the config into [{ name, api_key }] ------------------------
function loadWorkspaces(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  const pushOne = (name, obj) => {
    const key =
      typeof obj === "string"
        ? obj
        : obj?.api_key ?? obj?.apiKey ?? obj?.key ?? obj?.retell_api_key;
    if (key) out.push({ name: name ?? obj?.name ?? obj?.workspace_name ?? "(unnamed)", api_key: key });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) pushOne(item?.name ?? item?.workspace_name ?? item?.workspace, item);
  } else if (raw && typeof raw === "object") {
    // could be { workspaces: [...] } or { "Name": {...}, ... }
    if (Array.isArray(raw.workspaces)) {
      for (const item of raw.workspaces) pushOne(item?.name ?? item?.workspace_name, item);
    } else {
      for (const [name, obj] of Object.entries(raw)) pushOne(name, obj);
    }
  }
  // dedupe by api_key (shared keys => same workspace)
  const seen = new Set();
  return out.filter((w) => {
    if (seen.has(w.api_key)) return false;
    seen.add(w.api_key);
    return true;
  });
}

async function api(key, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

const backupDir = "./retell-backups";
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);

let totals = { workspaces: 0, agents: 0, patched: 0, skipped: 0, errors: 0 };

const workspaces = loadWorkspaces(CONFIG_PATH).filter((w) => !ONLY || w.name === ONLY);
console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${workspaces.length} workspace(s)${ONLY ? ` (filtered: ${ONLY})` : ""}\n`);

for (const ws of workspaces) {
  totals.workspaces++;
  console.log(`\n=== Workspace: ${ws.name} ===`);
  let agents;
  try {
    agents = await api(ws.api_key, "GET", "/list-agents");
  } catch (e) {
    console.error(`  ! list-agents failed: ${e.message}`);
    totals.errors++;
    continue;
  }
  const seenLlms = new Set(); // avoid double-patching a shared LLM
  for (const agent of agents) {
    totals.agents++;
    const agentId = agent.agent_id;
    const agentName = agent.agent_name ?? agentId;
    const llmId = agent.response_engine?.llm_id;
    if (!llmId) {
      console.log(`  - ${agentName}: no LLM (response_engine=${agent.response_engine?.type}) — skipped`);
      totals.skipped++;
      continue;
    }
    try {
      const llm = await api(ws.api_key, "GET", `/get-retell-llm/${llmId}`);
      const existing = Array.isArray(llm.post_call_analysis_data) ? llm.post_call_analysis_data : [];
      const already = existing.some((f) => f?.name === "link_requested");
      if (already) {
        console.log(`  - ${agentName} (llm ${llmId}): already has link_requested — skipped`);
        totals.skipped++;
        continue;
      }
      if (seenLlms.has(llmId)) {
        console.log(`  - ${agentName}: LLM ${llmId} already handled this run — skipped`);
        totals.skipped++;
        continue;
      }
      seenLlms.add(llmId);

      // back up the current analysis array before touching it
      writeFileSync(
        `${backupDir}/${ws.name.replace(/[^\w-]+/g, "_")}-${llmId}-${stamp}.json`,
        JSON.stringify(existing, null, 2)
      );

      const merged = [...existing, ...LINK_FIELDS];
      console.log(`  - ${agentName} (llm ${llmId}): ${existing.length} -> ${merged.length} analysis fields ${APPLY ? "" : "[dry run]"}`);

      if (APPLY) {
        const updated = await api(ws.api_key, "PATCH", `/update-retell-llm/${llmId}`, {
          post_call_analysis_data: merged,
        });
        const now = Array.isArray(updated.post_call_analysis_data) ? updated.post_call_analysis_data.length : 0;
        if (now !== merged.length) throw new Error(`verify failed: expected ${merged.length}, got ${now}`);
        await api(ws.api_key, "POST", `/publish-agent/${agentId}`, {});
        totals.patched++;
      } else {
        totals.patched++; // would-patch count
      }
    } catch (e) {
      console.error(`  ! ${agentName}: ${e.message}`);
      totals.errors++;
    }
  }
}

console.log(`\n---\n${APPLY ? "APPLIED" : "DRY RUN"} summary: ` +
  `${totals.workspaces} workspaces, ${totals.agents} agents, ` +
  `${totals.patched} ${APPLY ? "patched+published" : "would patch"}, ` +
  `${totals.skipped} skipped, ${totals.errors} errors.`);
console.log(`Backups in ${backupDir}/ (do NOT commit; contains client analysis config).`);
if (!APPLY) console.log(`\nRe-run with --apply to execute.`);
