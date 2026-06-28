import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  shouldAlertDialStall,
  shouldTriggerFailoverDrain,
  resolveFailoverDrainTrigger,
} from "./dial-watchdog";

describe("shouldAlertDialStall", () => {
  it("does not alert when the call window is closed", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: false,
        overduePendingCount: 5,
        recentDialCount: 0,
        heartbeatStale: true,
      }),
      false
    );
  });

  it("alerts on stale heartbeat with overdue pending rows", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: true,
        overduePendingCount: 3,
        recentDialCount: 2,
        heartbeatStale: true,
      }),
      true
    );
  });

  it("alerts when overdue pending and no recent dials in-window", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: true,
        overduePendingCount: 1,
        recentDialCount: 0,
        heartbeatStale: false,
      }),
      true
    );
  });
});

describe("shouldTriggerFailoverDrain", () => {
  it("triggers when Redis is unhealthy", () => {
    assert.equal(
      shouldTriggerFailoverDrain({
        heartbeatStale: false,
        stalledAgentCount: 0,
        redisUnhealthy: true,
      }),
      true
    );
  });

  it("triggers on dial stall with fresh heartbeat", () => {
    assert.equal(
      shouldTriggerFailoverDrain({
        heartbeatStale: false,
        stalledAgentCount: 2,
      }),
      true
    );
  });

  it("does not trigger when everything is healthy", () => {
    assert.equal(
      shouldTriggerFailoverDrain({
        heartbeatStale: false,
        stalledAgentCount: 0,
        redisUnhealthy: false,
      }),
      false
    );
  });
});

describe("resolveFailoverDrainTrigger", () => {
  it("prefers redis_unavailable over heartbeat_stale", () => {
    assert.equal(
      resolveFailoverDrainTrigger({
        heartbeatStale: true,
        stalledAgentCount: 1,
        redisUnhealthy: true,
      }),
      "redis_unavailable"
    );
  });

  it("returns null when no failover condition applies", () => {
    assert.equal(
      resolveFailoverDrainTrigger({
        heartbeatStale: false,
        stalledAgentCount: 0,
      }),
      null
    );
  });
});
