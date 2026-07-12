/**
 * Workspace / agent polling doctor.
 *
 * Usage:
 *   npx tsx scripts/poll-doctor.ts [workspaceId]
 *   npm run poll:doctor -- 28803e2d-a78d-4377-a718-824c58116151
 *
 * Requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();
import { createClient } from "@supabase/supabase-js";
import {
  diagnoseAgentPollHealth,
  diagnoseEngineHeartbeat,
  resolveDoctorEnrollTag,
  type PollDoctorAgentInput,
} from "@/lib/engine/poll-doctor";
import { contactHasEnrollTag } from "@/lib/agents/enroll-tag";

const WORKSPACE_NIL_PATEL = "28803e2d-a78d-4377-a718-824c58116151";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key);
}

function firstEmbedded<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function run(workspaceId: string) {
  const supabase = db();

  const { data: workspace, error: wsErr } = await supabase
    .from("workspaces")
    .select(
      "id, name, timezone, is_active, enroll_tag, crm_provider, crm_status, crm_credentials_encrypted"
    )
    .eq("id", workspaceId)
    .single();
  if (wsErr || !workspace) throw new Error(wsErr?.message ?? "workspace not found");

  const { data: agents } = await supabase
    .from("agents")
    .select(
      `id, name, status, direction, enroll_tag, crm_provider, crm_credentials_encrypted,
       agent_call_configs(daily_run_at, call_window_start, call_window_end, call_window_days)`
    )
    .eq("workspace_id", workspaceId)
    .order("name");

  const { data: heartbeat } = await supabase
    .from("engine_heartbeat")
    .select(
      "last_seen_at, scheduler_last_tick_at, poll_worker_last_seen_at, redis_last_ok"
    )
    .eq("id", "worker")
    .maybeSingle();

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, tags")
    .eq("workspace_id", workspaceId);

  const { data: recentPolls } = await supabase
    .from("poll_runs")
    .select(
      "agent_id, ran_at, scanned, eligible, enqueued, skipped_reason, trigger_source"
    )
    .eq("workspace_id", workspaceId)
    .order("ran_at", { ascending: false })
    .limit(50);

  const latestByAgent = new Map<
    string,
    {
      ran_at: string;
      scanned: number;
      skipped_reason: string | null;
      trigger_source: string;
    }
  >();
  for (const run of recentPolls ?? []) {
    if (!latestByAgent.has(run.agent_id)) {
      latestByAgent.set(run.agent_id, run);
    }
  }

  const { data: queueRows } = await supabase
    .from("call_queue_entries")
    .select("agent_id, status")
    .eq("workspace_id", workspaceId)
    .in("status", ["pending", "dialing"]);

  const activeQueueByAgent = new Map<string, number>();
  for (const row of queueRows ?? []) {
    activeQueueByAgent.set(
      row.agent_id,
      (activeQueueByAgent.get(row.agent_id) ?? 0) + 1
    );
  }

  console.log(`\n=== Poll doctor: ${workspace.name} (${workspace.id}) ===\n`);
  console.log(
    `Workspace: active=${workspace.is_active} tz=${workspace.timezone} crm=${workspace.crm_provider} crm_status=${workspace.crm_status ?? "n/a"} enroll_tag=${workspace.enroll_tag}`
  );

  const hbIssues = diagnoseEngineHeartbeat({
    lastSeenAt: heartbeat?.last_seen_at ?? null,
    schedulerLastTickAt: heartbeat?.scheduler_last_tick_at ?? null,
    pollWorkerLastSeenAt: heartbeat?.poll_worker_last_seen_at ?? null,
    redisLastOk: heartbeat?.redis_last_ok ?? null,
  });
  console.log(
    `Engine heartbeat: last_seen=${heartbeat?.last_seen_at ?? "null"} scheduler_tick=${heartbeat?.scheduler_last_tick_at ?? "null"} poll_worker=${heartbeat?.poll_worker_last_seen_at ?? "null"} redis_ok=${heartbeat?.redis_last_ok ?? "null"}`
  );
  if (hbIssues.length) {
    console.log(`  ISSUES: ${hbIssues.join(", ")}`);
  } else {
    console.log("  ISSUES: none");
  }

  const reports = [];
  for (const agent of agents ?? []) {
    const config = firstEmbedded(agent.agent_call_configs);
    const tag = resolveDoctorEnrollTag(agent.enroll_tag, workspace.enroll_tag);
    const localTaggedCount = (contacts ?? []).filter((c) =>
      contactHasEnrollTag(c.tags, tag)
    ).length;
    const latest = latestByAgent.get(agent.id);

    const input: PollDoctorAgentInput = {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      direction: agent.direction,
      enrollTag: agent.enroll_tag,
      workspaceEnrollTag: workspace.enroll_tag,
      workspaceIsActive: workspace.is_active,
      workspaceCrmProvider: workspace.crm_provider,
      hasWorkspaceCrmCredentials: Boolean(workspace.crm_credentials_encrypted),
      hasAgentCrmCredentials: Boolean(agent.crm_credentials_encrypted),
      dailyRunAt: config?.daily_run_at ?? null,
      callWindowStart: config?.call_window_start ?? null,
      callWindowEnd: config?.call_window_end ?? null,
      callWindowDays: config?.call_window_days ?? null,
      timezone: workspace.timezone,
      latestPollAt: latest?.ran_at ?? null,
      latestPollSource: latest?.trigger_source ?? null,
      latestPollScanned: latest?.scanned ?? null,
      latestPollSkip: latest?.skipped_reason ?? null,
      activeQueueRows: activeQueueByAgent.get(agent.id) ?? 0,
      localTaggedCount,
    };

    const report = diagnoseAgentPollHealth(input);
    reports.push(report);

    console.log(`\n— ${report.agentName} (${report.agentId})`);
    console.log(
      `  status=${report.status} direction=${report.direction} enroll_tag=${report.effectiveEnrollTag}`
    );
    console.log(
      `  window=${report.callWindow} days=[${report.callWindowDays.join(",")}] eligible_now=${report.pollTickEligible}`
    );
    console.log(
      `  local_tagged=${report.localTaggedCount} active_queue=${report.activeQueueRows}`
    );
    console.log(
      `  latest_poll=${report.latestPollAt ?? "never"} source=${report.latestPollSource ?? "n/a"} scanned=${report.latestPollScanned ?? "n/a"}${report.latestPollSkip ? ` skip=${report.latestPollSkip}` : ""}`
    );
    if (report.blockers.length) {
      console.log(`  BLOCKERS: ${report.blockers.join(", ")}`);
    } else {
      console.log("  BLOCKERS: none");
    }
  }

  const seriousAgentBlockers = reports.filter(
    (r) =>
      r.direction === "outbound" &&
      r.blockers.some((b) => b !== "outside_call_window_or_off_day")
  );
  console.log(
    `\nSummary: ${reports.length} agents, ${seriousAgentBlockers.length} outbound with serious blockers, ${hbIssues.length} engine issues.\n`
  );

  if (seriousAgentBlockers.length || hbIssues.length) {
    process.exitCode = 1;
  }
}

const workspaceId = process.argv[2] ?? WORKSPACE_NIL_PATEL;
run(workspaceId).catch((e) => {
  console.error(e);
  process.exit(1);
});
