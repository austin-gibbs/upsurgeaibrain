import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recoveredFromCall } from "./backfill-payloads";

describe("recoveredFromCall", () => {
  it("prefers wall-clock duration_ms and converts cents to USD", () => {
    const { seconds, costUsd } = recoveredFromCall({
      duration_ms: 90_000,
      call_cost: { combined_cost: 1234, total_duration_seconds: 60 },
    });
    assert.equal(seconds, 90); // duration_ms wins over billed 60s
    assert.equal(costUsd, 12.34); // 1234 cents -> $12.34
  });

  it("falls back to billed total_duration_seconds when duration_ms is missing/zero", () => {
    const { seconds } = recoveredFromCall({
      duration_ms: 0,
      call_cost: { combined_cost: 500, total_duration_seconds: 42 },
    });
    assert.equal(seconds, 42);
  });

  it("accepts the enveloped { call } shape defensively", () => {
    const { seconds, costUsd } = recoveredFromCall({
      event: "call_analyzed",
      call: { duration_ms: 30_000, call_cost: { combined_cost: 250 } },
    });
    assert.equal(seconds, 30);
    assert.equal(costUsd, 2.5);
  });

  it("coerces Retell's stringified numbers", () => {
    const { seconds, costUsd } = recoveredFromCall({
      duration_ms: "120000",
      call_cost: { combined_cost: "999" },
    });
    assert.equal(seconds, 120);
    assert.equal(costUsd, 9.99);
  });

  it("returns zeros for junk / empty input", () => {
    assert.deepEqual(recoveredFromCall(null), { seconds: 0, costUsd: 0 });
    assert.deepEqual(recoveredFromCall({}), { seconds: 0, costUsd: 0 });
    assert.deepEqual(recoveredFromCall({ call_cost: { combined_cost: "abc" } }), {
      seconds: 0,
      costUsd: 0,
    });
  });
});
