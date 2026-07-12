import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseAgentPollHealth,
  diagnoseEngineHeartbeat,
  resolveDoctorEnrollTag,
} from "./poll-doctor";

describe("resolveDoctorEnrollTag", () => {
  it("prefers agent enroll tag over workspace default", () => {
    assert.equal(
      resolveDoctorEnrollTag("upsurge.circleprospecting.ai", "upsurge.probate.ai"),
      "upsurge.circleprospecting.ai"
    );
  });

  it("falls back to workspace enroll tag when agent tag is null", () => {
    assert.equal(
      resolveDoctorEnrollTag(null, "upsurge.probate.ai"),
      "upsurge.probate.ai"
    );
  });

  it("does not hardcode a probate workspace default", () => {
    assert.equal(
      resolveDoctorEnrollTag(undefined, "Workspace.Default.Tag"),
      "workspace.default.tag"
    );
  });
});

describe("diagnoseAgentPollHealth", () => {
  const base = {
    id: "agent-1",
    name: "Circle Prospecting",
    status: "active",
    direction: "outbound" as const,
    enrollTag: "upsurge.circleprospecting.ai",
    workspaceEnrollTag: "upsurge.probate.ai",
    workspaceIsActive: true,
    workspaceCrmProvider: "followupboss",
    hasWorkspaceCrmCredentials: true,
    hasAgentCrmCredentials: false,
    dailyRunAt: "15:00",
    callWindowStart: "15:00",
    callWindowEnd: "19:00",
    callWindowDays: [2, 3, 4, 5, 6, 7],
    timezone: "America/New_York",
    latestPollAt: new Date().toISOString(),
    latestPollSource: "worker",
    latestPollScanned: 2,
    latestPollSkip: null,
    activeQueueRows: 0,
    localTaggedCount: 2,
  };

  it("uses agent enroll tag in the report", () => {
    const report = diagnoseAgentPollHealth(base);
    assert.equal(report.effectiveEnrollTag, "upsurge.circleprospecting.ai");
    assert.ok(!report.blockers.includes("missing_crm_credentials"));
  });

  it("flags missing CRM credentials", () => {
    const report = diagnoseAgentPollHealth({
      ...base,
      hasWorkspaceCrmCredentials: false,
      hasAgentCrmCredentials: false,
    });
    assert.ok(report.blockers.includes("missing_crm_credentials"));
  });

  it("flags missing recent coverage when eligible and stale", () => {
    const report = diagnoseAgentPollHealth(
      {
        ...base,
        latestPollAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        // Force eligibility path via blockers: we check lacksRecent when eligible.
        // Eligibility depends on wall clock; if currently outside window this
        // assertion still validates the coverage age math via lacksRecent.
      },
      { coverageMaxAgeMs: 90_000 }
    );
    assert.equal(report.lacksRecentPollCoverage, true);
  });
});

describe("diagnoseEngineHeartbeat", () => {
  it("flags stale scheduler and never-seen poll worker", () => {
    const now = Date.now();
    const issues = diagnoseEngineHeartbeat({
      lastSeenAt: new Date(now).toISOString(),
      schedulerLastTickAt: new Date(now - 10 * 60_000).toISOString(),
      pollWorkerLastSeenAt: null,
      redisLastOk: true,
      nowMs: now,
    });
    assert.ok(issues.includes("scheduler_tick_stale"));
    assert.ok(issues.includes("poll_worker_never_seen"));
  });
});
