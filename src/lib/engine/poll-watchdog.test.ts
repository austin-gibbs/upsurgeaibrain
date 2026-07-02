import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldAlertPollGap } from "./poll-watchdog";

describe("shouldAlertPollGap", () => {
  it("alerts when poll tick is eligible but coverage is missing", () => {
    assert.equal(
      shouldAlertPollGap({
        pollTickEligible: true,
        lacksPollCoverage: true,
        activeQueueCount: 0,
        recentDialCount: 0,
      }),
      true
    );
  });

  it("does not alert when recent dials exist", () => {
    assert.equal(
      shouldAlertPollGap({
        pollTickEligible: true,
        lacksPollCoverage: true,
        activeQueueCount: 0,
        recentDialCount: 2,
      }),
      false
    );
  });

  it("does not alert when queue rows are still active", () => {
    assert.equal(
      shouldAlertPollGap({
        pollTickEligible: true,
        lacksPollCoverage: true,
        activeQueueCount: 3,
        recentDialCount: 0,
      }),
      false
    );
  });

  it("does not alert outside poll tick eligibility", () => {
    assert.equal(
      shouldAlertPollGap({
        pollTickEligible: false,
        lacksPollCoverage: true,
        activeQueueCount: 0,
        recentDialCount: 0,
      }),
      false
    );
  });
});
