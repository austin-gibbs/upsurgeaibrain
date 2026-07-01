// Rollover-first queue ordering and poll capacity helpers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compareQueueRowsForRollover,
  computeNewPollCapacity,
  computeRepeatedPollCapacity,
  remainingDailyDialBudget,
  excludeActiveQueuedContacts,
  findUnenrolledPendingQueueRows,
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

describe("computeRepeatedPollCapacity", () => {
  it("subtracts rollover backlog, same-day queued, and dialed counts", () => {
    assert.equal(
      computeRepeatedPollCapacity({
        dailyCap: 100,
        rolloverBacklogCount: 10,
        sameDayQueuedCount: 40,
        dialedTodayCount: 20,
      }),
      30
    );
  });

  it("returns zero when same-day commitments exhaust the budget", () => {
    assert.equal(
      computeRepeatedPollCapacity({
        dailyCap: 50,
        rolloverBacklogCount: 40,
        sameDayQueuedCount: 5,
        dialedTodayCount: 5,
      }),
      0
    );
  });

  it("never returns negative capacity", () => {
    assert.equal(
      computeRepeatedPollCapacity({
        dailyCap: 10,
        rolloverBacklogCount: 20,
        sameDayQueuedCount: 5,
        dialedTodayCount: 5,
      }),
      0
    );
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

describe("findUnenrolledPendingQueueRows", () => {
  const rows = [
    { id: "r1", contact_id: "a", status: "pending", queue_day: "2026-06-28" },
    { id: "r2", contact_id: "b", status: "pending", queue_day: "2026-06-29" },
    { id: "r3", contact_id: "c", status: "dialing", queue_day: "2026-06-29" },
    { id: "r4", contact_id: "d", status: "pending", queue_day: "2026-06-25" },
  ];

  it("flags pending rows whose contact is not in the enrolled set", () => {
    const stale = findUnenrolledPendingQueueRows(rows, new Set(["a", "b"]));
    assert.deepEqual(
      stale.map((r) => r.id),
      ["r4"]
    );
  });

  it("keeps pending rows for contacts still enrolled", () => {
    const stale = findUnenrolledPendingQueueRows(rows, new Set(["a", "b", "d"]));
    assert.equal(stale.length, 0);
  });

  it("cancels all pending rows when enrolled set is empty", () => {
    const stale = findUnenrolledPendingQueueRows(rows, new Set());
    assert.deepEqual(
      stale.map((r) => r.id),
      ["r1", "r2", "r4"]
    );
  });

  it("never selects dialing rows even when contact is unenrolled", () => {
    const stale = findUnenrolledPendingQueueRows(rows, new Set(["a", "b"]));
    assert.ok(!stale.some((r) => r.status === "dialing"));
  });
});
