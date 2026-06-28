import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { drainCapacityPerTick } from "./drain";

describe("drainCapacityPerTick", () => {
  it("returns 1 when drip is zero or negative", () => {
    assert.equal(drainCapacityPerTick(0), 1);
    assert.equal(drainCapacityPerTick(-5), 1);
  });

  it("respects drip spacing within a 60s cron tick", () => {
    assert.equal(drainCapacityPerTick(60), 2);
    assert.equal(drainCapacityPerTick(30), 3);
    assert.equal(drainCapacityPerTick(120), 1);
  });
});
