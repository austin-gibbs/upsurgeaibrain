import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POLL_INTERVAL_MINUTES,
  buildPollJobId,
  isAgentEligibleForPollTick,
  pollBucketFromHHMM,
} from "./poll-schedule";

describe("pollBucketFromHHMM", () => {
  it("floors minutes to 2-minute buckets", () => {
    assert.equal(POLL_INTERVAL_MINUTES, 2);
    assert.equal(pollBucketFromHHMM("09:00"), "09:00");
    assert.equal(pollBucketFromHHMM("09:01"), "09:00");
    assert.equal(pollBucketFromHHMM("09:02"), "09:02");
    assert.equal(pollBucketFromHHMM("09:03"), "09:02");
    assert.equal(pollBucketFromHHMM("09:58"), "09:58");
    assert.equal(pollBucketFromHHMM("09:59"), "09:58");
  });
});

describe("buildPollJobId", () => {
  it("keys jobs to agent, local date, and bucket", () => {
    assert.equal(
      buildPollJobId("agent-1", "2026-06-30", "09:02"),
      "poll:agent-1:2026-06-30:09:02"
    );
  });
});

describe("isAgentEligibleForPollTick", () => {
  const base = {
    timezone: "America/New_York",
    dailyRunAt: "09:00",
    callWindowStart: "09:00",
    callWindowEnd: "19:00",
    callWindowDays: [1, 2, 3, 4, 5, 6, 7] as number[],
  };

  it("is false before daily_run_at", () => {
    assert.equal(
      isAgentEligibleForPollTick({ ...base, nowHHMM: "08:59" }),
      false
    );
  });

  it("is false before call window opens even after daily_run_at", () => {
    assert.equal(
      isAgentEligibleForPollTick({
        ...base,
        dailyRunAt: "08:00",
        callWindowStart: "09:00",
        nowHHMM: "08:30",
      }),
      false
    );
  });

  it("is true inside the call window", () => {
    assert.equal(
      isAgentEligibleForPollTick({ ...base, nowHHMM: "10:15" }),
      true
    );
  });

  it("is false after call window end", () => {
    assert.equal(
      isAgentEligibleForPollTick({ ...base, nowHHMM: "19:01" }),
      false
    );
  });

  it("is false on disallowed weekdays", () => {
    assert.equal(
      isAgentEligibleForPollTick({
        ...base,
        callWindowDays: [1, 3, 5],
        isoDate: "2026-06-30", // Tuesday
        nowHHMM: "10:00",
      }),
      false
    );
  });
});
