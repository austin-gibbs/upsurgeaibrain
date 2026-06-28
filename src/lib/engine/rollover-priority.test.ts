// Rollover-first queue ordering and poll capacity helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compareQueueRowsForRollover,
  computeNewPollCapacity,
  remainingDailyDialBudget,
  excludeActiveQueuedContacts,
} from "./rollover-priority";

describe("compareQueueRowsForRollover", () => {
  it("sorts older queue_day before newer even when position is higher", () => {
    const rows = [
      { queue_day: "2026-06-27", position: 1, enqueued_at: "2026-06-27T09:00:00Z" },
      { queue_day: "2026-06-25", position: 92, enqueued_at: "2026-06-25T09:00:00Z" },
      { queue_day: "2026-06-26", position: 50, enqueued_at: "2026-06-26T09:00:00Z" },
    ];
    rows.sort(compareQueueRowsForRollover);
    assert.deepEqual(
      rows.map((r) => r.queue_day),
      ["2026-06-25", "2026-06-26", "2026-06-27"]
    );
  });

  it("breaks ties by position then enqueued_at", () => {
    const rows = [
      { queue_day: "2026-06-25", position: 2, enqueued_at: "2026-06-25T10:00:00Z" },
      { queue_day: "2026-06-25", position: 1, enqueued_at: "2026-06-25T11:00:00Z" },
      { queue_day: "2026-06-25", position: 2, enqueued_at: "2026-06-25T09:00:00Z" },
    ];
    rows.sort(compareQueueRowsForRollover);
    assert.deepEqual(
      rows.map((r) => [r.position, r.enqueued_at]),
      [
        [1, "2026-06-25T11:00:00Z"],
        [2, "2026-06-25T09:00:00Z"],
        [2, "2026-06-25T10:00:00Z"],
      ]
    );
  });
});

describe("computeNewPollCapacity", () => {
  it("reserves poll capacity for rollover backlog", () => {
    assert.equal(computeNewPollCapacity(100, 37), 63);
    assert.equal(computeNewPollCapacity(100, 100), 0);
    assert.equal(computeNewPollCapacity(100, 150), 0);
  });

  it("never returns negative capacity", () => {
    assert.equal(computeNewPollCapacity(50, -5), 50);
  });
});

describe("remainingDailyDialBudget", () => {
  it("subtracts dials already placed today", () => {
    assert.equal(remainingDailyDialBudget(100, 30), 70);
    assert.equal(remainingDailyDialBudget(100, 100), 0);
    assert.equal(remainingDailyDialBudget(100, 120), 0);
  });
});

describe("excludeActiveQueuedContacts", () => {
  it("drops contacts already in the active queue", () => {
    const contacts = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const filtered = excludeActiveQueuedContacts(contacts, new Set(["b", "d"]));
    assert.deepEqual(
      filtered.map((c) => c.id),
      ["a", "c"]
    );
  });
});
