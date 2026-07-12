import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  POLL_INTERVAL_SECONDS,
  POLL_COVERAGE_MAX_AGE_MS,
  buildPollJobId,
  isAgentEligibleForPollTick,
  pollBucketFromHHMMSS,
} from "./poll-schedule";

describe("pollBucketFromHHMMSS", () => {
  it("floors seconds to 30-second buckets", () => {
    assert.equal(POLL_INTERVAL_SECONDS, 30);
    assert.equal(POLL_COVERAGE_MAX_AGE_MS, 90_000);
    assert.equal(pollBucketFromHHMMSS("09:00:00"), "09:00:00");
    assert.equal(pollBucketFromHHMMSS("09:00:15"), "09:00:00");
    assert.equal(pollBucketFromHHMMSS("09:00:29"), "09:00:00");
    assert.equal(pollBucketFromHHMMSS("09:00:30"), "09:00:30");
    assert.equal(pollBucketFromHHMMSS("09:00:45"), "09:00:30");
    assert.equal(pollBucketFromHHMMSS("09:00:59"), "09:00:30");
    assert.equal(pollBucketFromHHMMSS("09:01:00"), "09:01:00");
  });
});

describe("buildPollJobId", () => {
  it("keys jobs to agent, local date, and bucket", () => {
    assert.equal(
      buildPollJobId("agent-1", "2026-06-30", "09:00:30"),
      "poll-agent-1-2026-06-30-090030"
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

  it("matches Nil Patel Probate window on a weekday", () => {
    const nilPatel = {
      timezone: "America/New_York",
      dailyRunAt: "08:00",
      callWindowStart: "11:00",
      callWindowEnd: "19:00",
      callWindowDays: [2, 3, 4, 5, 6] as number[],
      isoDate: "2026-07-01", // Wednesday
    };
    assert.equal(
      isAgentEligibleForPollTick({ ...nilPatel, nowHHMM: "10:59" }),
      false
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...nilPatel, nowHHMM: "11:00" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...nilPatel, nowHHMM: "18:59" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...nilPatel, nowHHMM: "19:00" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...nilPatel, nowHHMM: "19:01" }),
      false
    );
  });

  it("matches Nil Patel Circle Prospecting Sunday 3pm–7pm window", () => {
    const circle = {
      timezone: "America/New_York",
      dailyRunAt: "15:00",
      callWindowStart: "15:00",
      callWindowEnd: "19:00",
      callWindowDays: [2, 3, 4, 5, 6, 7] as number[],
      isoDate: "2026-07-12", // Sunday
    };
    assert.equal(
      isAgentEligibleForPollTick({ ...circle, nowHHMM: "14:59" }),
      false
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...circle, nowHHMM: "15:00" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...circle, nowHHMM: "17:30" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...circle, nowHHMM: "19:00" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...circle, nowHHMM: "19:01" }),
      false
    );
    // Sunday excluded still blocks even inside clock window
    assert.equal(
      isAgentEligibleForPollTick({
        ...circle,
        callWindowDays: [2, 3, 4, 5, 6],
        nowHHMM: "16:00",
      }),
      false
    );
  });

  it("matches Diamond Seller Outgoing all-week window", () => {
    const diamondSeller = {
      timezone: "America/Los_Angeles",
      dailyRunAt: "09:00",
      callWindowStart: "09:00",
      callWindowEnd: "20:00",
      callWindowDays: [1, 2, 3, 4, 5, 6, 7] as number[],
      isoDate: "2026-07-01",
    };
    assert.equal(
      isAgentEligibleForPollTick({ ...diamondSeller, nowHHMM: "08:59" }),
      false
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...diamondSeller, nowHHMM: "12:30" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...diamondSeller, nowHHMM: "20:00" }),
      true
    );
    assert.equal(
      isAgentEligibleForPollTick({ ...diamondSeller, nowHHMM: "20:01" }),
      false
    );
  });
});
