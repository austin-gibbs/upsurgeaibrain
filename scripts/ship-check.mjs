#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "ship-check-output.txt");

const files = [
  "supabase/migrations/0010_highlevel_opportunity_automation.sql",
  "src/lib/engine/pipeline-routing.ts",
  "src/app/api/agents/[id]/opportunity-fields/route.ts",
  "src/components/agent-form/PipelineStageSettings.tsx",
  "src/app/agents/[id]/page.tsx",
  "src/lib/engine/poll-stage-routing.test.ts",
  "src/lib/engine/pipeline-routing.test.ts",
  "scripts/apply-0010.mjs",
];

const lines = [];
function run(cmd) {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8" });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "") + `\nEXIT:${e.status}\n`;
  }
}

lines.push("=== git status ===\n", run("git status --short"));
lines.push("\n=== git diff --stat ===\n", run("git diff --stat"));
lines.push("\n=== git log -5 ===\n", run("git log -5 --oneline"));
lines.push("\n=== file checks ===\n");
for (const f of files) {
  const exists = fs.existsSync(path.join(root, f));
  lines.push(`${f}: exists=${exists} ${run(`git status --short -- "${f}"`).trim()}\n`);
}

fs.writeFileSync(out, lines.join(""));
console.log("Wrote", out);
