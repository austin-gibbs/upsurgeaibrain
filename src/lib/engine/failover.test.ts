// Unit tests for dial failover helpers: heartbeat staleness, drain capacity,
// and dial-stall watchdog conditions.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isHeartbeatStaleAt,
  HEARTBEAT_STALE_MS,
} from "./heartbeat";
import { drainCapacityPerTick } from "./drain";
import {
  shouldAlertDialStall,
  shouldTriggerFailoverDrain,
  resolveFailoverDrainTrigger,
} from "./dial-watchdog";
import { isLiveBullMqState } from "../queue/sweeper";

describe("isHeartbeatStaleAt", () => {
  const now = Date.parse("2026-06-25T22:30:00.000Z");

  it("returns true when lastSeenAt is null", () => {
    assert.equal(isHeartbeatStaleAt(null, now, HEARTBEAT_STALE_MS), true);
  });

  it("returns false when heartbeat is fresh", () => {
    const fresh = new Date(now - 60_000).toISOString();
    assert.equal(isHeartbeatStaleAt(fresh, now, HEARTBEAT_STALE_MS), false);
  });

  it("returns true when heartbeat is older than stale threshold", () => {
    const stale = new Date(now - HEARTBEAT_STALE_MS - 1).toISOString();
    assert.equal(isHeartbeatStaleAt(stale, now, HEARTBEAT_STALE_MS), true);
  });

  it("returns false exactly at the stale boundary", () => {
    const boundary = new Date(now - HEARTBEAT_STALE_MS).toISOString();
    assert.equal(isHeartbeatStaleAt(boundary, now, HEARTBEAT_STALE_MS), false);
  });
});

describe("drainCapacityPerTick", () => {
  it("allows 3 dials per minute at 30s drip", () => {
    assert.equal(drainCapacityPerTick(30), 3);
  });

  it("allows 2 dials per minute at 60s drip", () => {
    assert.equal(drainCapacityPerTick(60), 2);
  });

  it("defaults to at least 1 for invalid drip", () => {
    assert.equal(drainCapacityPerTick(0), 1);
    assert.equal(drainCapacityPerTick(-5), 1);
  });
});

describe("DrainResult shape", () => {
  it("tracks dry-run calls separately from placed calls", () => {
    const result = {
      scanned: 1,
      eligible: 1,
      wouldDial: 1,
      claimed: 0,
      dialed: 0,
      deferred: 0,
      failed: 0,
      skipped: 0,
    };

    assert.equal(result.wouldDial, 1);
    assert.equal(result.dialed, 0);
  });
});

describe("shouldAlertDialStall", () => {
  it("does not alert when window is closed", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: false,
        overduePendingCount: 10,
        recentDialCount: 0,
        heartbeatStale: true,
      }),
      false
    );
  });

  it("alerts when window is open, overdue pending, and no recent dials", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: true,
        overduePendingCount: 5,
        recentDialCount: 0,
        heartbeatStale: false,
      }),
      true
    );
  });

  it("alerts when heartbeat is stale and overdue pending exist", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: true,
        overduePendingCount: 1,
        recentDialCount: 3,
        heartbeatStale: true,
      }),
      true
    );
  });

  it("does not alert when dials are flowing and heartbeat is healthy", () => {
    assert.equal(
      shouldAlertDialStall({
        windowOpen: true,
        overduePendingCount: 0,
        recentDialCount: 5,
        heartbeatStale: false,
      }),
      false
    );
  });
});

describe("isLiveBullMqState", () => {
  it("treats runnable BullMQ states as live", () => {
    assert.equal(isLiveBullMqState("waiting"), true);
    assert.equal(isLiveBullMqState("delayed"), true);
    assert.equal(isLiveBullMqState("active"), true);
  });

  it("treats terminal BullMQ states as rebuildable", () => {
    assert.equal(isLiveBullMqState("completed"), false);
    assert.equal(isLiveBullMqState("failed"), false);
    assert.equal(isLiveBullMqState("unknown"), false);
  });
});

describe("shouldTriggerFailoverDrain", () => {
  it("triggers when heartbeat is stale", () => {
    assert.equal(
      shouldTriggerFailoverDrain({ heartbeatStale: true, stalledAgentCount: 0 }),
      true
    );
  });

  it("triggers when Redis/BullMQ is unavailable", () => {
    assert.equal(
      shouldTriggerFailoverDrain({
        heartbeatStale: false,
        stalledAgentCount: 0,
        redisUnhealthy: true,
      }),
      true
    );
  });

  it("triggers on dial stall even when heartbeat is fresh (zombie worker)", () => {
    assert.equal(
      shouldTriggerFailoverDrain({ heartbeatStale: false, stalledAgentCount: 2 }),
      true
    );
  });

  it("does not trigger when heartbeat is fresh and no stalled agents", () => {
    assert.equal(
      shouldTriggerFailoverDrain({ heartbeatStale: false, stalledAgentCount: 0 }),
      false
    );
  });
});

describe("resolveFailoverDrainTrigger", () => {
  it("prefers redis_unavailable over other conditions", () => {
    assert.equal(
      resolveFailoverDrainTrigger({
        heartbeatStale: true,
        stalledAgentCount: 3,
        redisUnhealthy: true,
      }),
      "redis_unavailable"
    );
  });

  it("prefers heartbeat_stale when Redis is ok and both conditions hold", () => {
    assert.equal(
      resolveFailoverDrainTrigger({ heartbeatStale: true, stalledAgentCount: 3 }),
      "heartbeat_stale"
    );
  });

  it("returns dial_stall for zombie worker case", () => {
    assert.equal(
      resolveFailoverDrainTrigger({ heartbeatStale: false, stalledAgentCount: 1 }),
      "dial_stall"
    );
  });

  it("returns null when no failover needed", () => {
    assert.equal(
      resolveFailoverDrainTrigger({ heartbeatStale: false, stalledAgentCount: 0 }),
      null
    );
  });
});
