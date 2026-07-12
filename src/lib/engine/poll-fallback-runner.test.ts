import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapWithConcurrency,
  type PollFallbackCandidate,
} from "./poll-fallback-runner";

describe("mapWithConcurrency", () => {
  it("runs all items with bounded parallelism", async () => {
    const order: number[] = [];
    const items = [1, 2, 3, 4, 5];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      order.push(n);
      return n * 2;
    });
    assert.deepEqual(results, [2, 4, 6, 8, 10]);
    assert.equal(order.length, 5);
  });
});

describe("poll-fallback candidate ordering", () => {
  it("prioritizes agents lacking coverage before stable agents", () => {
    const candidates: PollFallbackCandidate[] = [
      { agentId: "b", lacksPollCoverage: false },
      { agentId: "a", lacksPollCoverage: true },
      { agentId: "c", lacksPollCoverage: true },
    ];
    candidates.sort((a, b) => {
      if (a.lacksPollCoverage !== b.lacksPollCoverage) {
        return a.lacksPollCoverage ? -1 : 1;
      }
      return a.agentId.localeCompare(b.agentId);
    });
    assert.deepEqual(
      candidates.map((c) => c.agentId),
      ["a", "c", "b"]
    );
  });
});
