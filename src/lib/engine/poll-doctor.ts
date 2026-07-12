// Workspace / agent polling doctor — pure helpers for audits + the CLI script.
import {
  isAgentEligibleForPollTick,
  POLL_COVERAGE_MAX_AGE_MS,
} from "./poll-schedule";
import { isHeartbeatStaleAt, HEARTBEAT_STALE_MS } from "./heartbeat";
import { effectiveEnrollTag } from "@/lib/agents/enroll-tag";

export interface PollDoctorAgentInput {
  id: string;
  name: string;
  status: string;
  direction: "inbound" | "outbound" | string;
  enrollTag: string | null;
  workspaceEnrollTag: string;
  workspaceIsActive: boolean;
  workspaceCrmProvider: string | null;
  hasWorkspaceCrmCredentials: boolean;
  hasAgentCrmCredentials: boolean;
  dailyRunAt: string | null;
  callWindowStart: string | null;
  callWindowEnd: string | null;
  callWindowDays: number[] | null;
  timezone: string;
  latestPollAt: string | null;
  latestPollSource: string | null;
  latestPollScanned: number | null;
  latestPollSkip: string | null;
  activeQueueRows: number;
  localTaggedCount: number;
}

export interface PollDoctorAgentReport {
  agentId: string;
  agentName: string;
  direction: string;
  status: string;
  effectiveEnrollTag: string;
  callWindow: string;
  callWindowDays: number[];
  pollTickEligible: boolean;
  latestPollAt: string | null;
  latestPollSource: string | null;
  latestPollScanned: number | null;
  latestPollSkip: string | null;
  activeQueueRows: number;
  localTaggedCount: number;
  lacksRecentPollCoverage: boolean;
  blockers: string[];
}

export interface PollDoctorHeartbeatInput {
  lastSeenAt: string | null;
  schedulerLastTickAt: string | null;
  pollWorkerLastSeenAt: string | null;
  redisLastOk: boolean | null;
  nowMs?: number;
}

/**
 * Resolve the CRM tag the poller will query for this agent.
 * Prefer agent.enroll_tag; fall back to workspace.enroll_tag.
 */
export function resolveDoctorEnrollTag(
  agentEnrollTag: string | null | undefined,
  workspaceEnrollTag: string
): string {
  return effectiveEnrollTag(agentEnrollTag, workspaceEnrollTag);
}

export function diagnoseAgentPollHealth(
  agent: PollDoctorAgentInput,
  opts?: { nowMs?: number; coverageMaxAgeMs?: number }
): PollDoctorAgentReport {
  const nowMs = opts?.nowMs ?? Date.now();
  const coverageMaxAgeMs = opts?.coverageMaxAgeMs ?? POLL_COVERAGE_MAX_AGE_MS;
  const tag = resolveDoctorEnrollTag(agent.enrollTag, agent.workspaceEnrollTag);
  const days = agent.callWindowDays?.length
    ? [...agent.callWindowDays]
    : [1, 2, 3, 4, 5, 6, 7];
  const blockers: string[] = [];

  if (agent.direction !== "outbound") {
    blockers.push("not_outbound");
  }
  if (agent.status !== "active") {
    blockers.push(`agent_${agent.status}`);
  }
  if (!agent.workspaceIsActive) {
    blockers.push("workspace_inactive");
  }
  if (!agent.dailyRunAt || !agent.callWindowStart || !agent.callWindowEnd) {
    blockers.push("missing_call_config");
  }
  if (!agent.hasWorkspaceCrmCredentials && !agent.hasAgentCrmCredentials) {
    blockers.push("missing_crm_credentials");
  }

  const pollTickEligible =
    agent.direction === "outbound" &&
    agent.status === "active" &&
    agent.workspaceIsActive &&
    Boolean(agent.dailyRunAt && agent.callWindowStart && agent.callWindowEnd) &&
    isAgentEligibleForPollTick({
      timezone: agent.timezone,
      dailyRunAt: agent.dailyRunAt ?? "00:00",
      callWindowStart: agent.callWindowStart ?? "00:00",
      callWindowEnd: agent.callWindowEnd ?? "23:59",
      callWindowDays: days,
    });

  if (
    agent.direction === "outbound" &&
    agent.status === "active" &&
    agent.workspaceIsActive &&
    agent.dailyRunAt &&
    agent.callWindowStart &&
    agent.callWindowEnd &&
    !pollTickEligible
  ) {
    blockers.push("outside_call_window_or_off_day");
  }

  const lacksRecentPollCoverage =
    !agent.latestPollAt ||
    nowMs - new Date(agent.latestPollAt).getTime() > coverageMaxAgeMs;

  if (pollTickEligible && lacksRecentPollCoverage) {
    blockers.push("missing_recent_poll_coverage");
  }

  if (pollTickEligible && agent.localTaggedCount === 0) {
    blockers.push("no_local_contacts_with_enroll_tag");
  }

  return {
    agentId: agent.id,
    agentName: agent.name,
    direction: agent.direction,
    status: agent.status,
    effectiveEnrollTag: tag,
    callWindow: `${agent.callWindowStart ?? "?"}–${agent.callWindowEnd ?? "?"} (${agent.timezone})`,
    callWindowDays: days,
    pollTickEligible,
    latestPollAt: agent.latestPollAt,
    latestPollSource: agent.latestPollSource,
    latestPollScanned: agent.latestPollScanned,
    latestPollSkip: agent.latestPollSkip,
    activeQueueRows: agent.activeQueueRows,
    localTaggedCount: agent.localTaggedCount,
    lacksRecentPollCoverage,
    blockers,
  };
}

export function diagnoseEngineHeartbeat(
  hb: PollDoctorHeartbeatInput
): string[] {
  const nowMs = hb.nowMs ?? Date.now();
  const issues: string[] = [];
  if (isHeartbeatStaleAt(hb.lastSeenAt, nowMs, HEARTBEAT_STALE_MS)) {
    issues.push("worker_heartbeat_stale");
  }
  // Scheduler should tick at least every ~2 minutes when the internal loop is on.
  if (isHeartbeatStaleAt(hb.schedulerLastTickAt, nowMs, 2 * 60 * 1000)) {
    issues.push("scheduler_tick_stale");
  }
  if (!hb.pollWorkerLastSeenAt) {
    issues.push("poll_worker_never_seen");
  } else if (
    isHeartbeatStaleAt(hb.pollWorkerLastSeenAt, nowMs, 30 * 60 * 1000)
  ) {
    issues.push("poll_worker_stale");
  }
  if (hb.redisLastOk === false) {
    issues.push("redis_unhealthy");
  }
  return issues;
}
