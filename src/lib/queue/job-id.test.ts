import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeBullmqJobId } from "./job-id";

describe("sanitizeBullmqJobId", () => {
  it("strips colons so BullMQ 5 accepts the id", () => {
    assert.equal(
      sanitizeBullmqJobId("poll:agent:2026-07-12:15:00:30"),
      "poll-agent-2026-07-12-15-00-30"
    );
  });

  it("is idempotent for already-safe ids", () => {
    assert.equal(
      sanitizeBullmqJobId("poll-agent-2026-07-12-150030"),
      "poll-agent-2026-07-12-150030"
    );
  });
});
