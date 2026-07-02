import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  POLL_COVERAGE_MAX_AGE_MS,
  pollCoverageCutoffIso,
  shouldPollAgentInFailover,
} from "./poll-coverage";

describe("pollCoverageCutoffIso", () => {
  it("subtracts the coverage window from now", () => {
    const now = Date.parse("2026-07-01T15:00:00.000Z");
    const cutoff = pollCoverageCutoffIso(now, POLL_COVERAGE_MAX_AGE_MS);
    assert.equal(cutoff, "2026-07-01T14:55:00.000Z");
  });
});

describe("shouldPollAgentInFailover", () => {
  it("polls all in-window agents when infrastructure failover is active", () => {
    assert.equal(
      shouldPollAgentInFailover({
        infrastructureFailover: true,
        pollTickEligible: true,
        lacksPollCoverage: false,
      }),
      true
    );
  });

  it("polls when heartbeat is healthy but poll coverage is missing", () => {
    assert.equal(
      shouldPollAgentInFailover({
        infrastructureFailover: false,
        pollTickEligible: true,
        lacksPollCoverage: true,
      }),
      true
    );
  });

  it("skips when worker is healthy and poll coverage exists", () => {
    assert.equal(
      shouldPollAgentInFailover({
        infrastructureFailover: false,
        pollTickEligible: true,
        lacksPollCoverage: false,
      }),
      false
    );
  });

  it("skips outside poll tick eligibility", () => {
    assert.equal(
      shouldPollAgentInFailover({
        infrastructureFailover: true,
        pollTickEligible: false,
        lacksPollCoverage: true,
      }),
      false
    );
  });
});
