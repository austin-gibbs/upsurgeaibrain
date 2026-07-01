import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dailyWindowCapacity, pollEnqueueCapacity } from "./cadence";

describe("pollEnqueueCapacity", () => {
  it("uses full daily capacity when outside the call window", () => {
    const start = "00:00";
    const end = "00:01";
    const drip = 60;
    const cap = pollEnqueueCapacity(
      "UTC",
      start,
      end,
      drip,
      [1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(cap, dailyWindowCapacity(start, end, drip));
    assert.ok(cap > 0);
  });
});
