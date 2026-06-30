// Poll enrollment sync — cadence preservation, reconcile helpers, no double-queue.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMergedContactRows,
  stripEnrollTagFromTags,
  enrolledCrmIds,
} from "./poller-sync";
import { excludeActiveQueuedContacts, findUnenrolledPendingQueueRows } from "./rollover-priority";
import type { Contact } from "@/types";

const existingContact = (overrides: Partial<Contact> = {}): Contact => ({
  id: "uuid-1",
  workspace_id: "ws-1",
  crm_contact_id: "100",
  full_name: "Jane Doe",
  email: null,
  phones: ["+15551234567"],
  tags: ["upsurge.probate.ai"],
  attempt_count: 2,
  last_called_on: "2026-06-24",
  next_eligible_on: "2026-06-28",
  is_terminal: false,
  terminal_outcome: null,
  ...overrides,
});

describe("buildMergedContactRows", () => {
  it("preserves cadence fields for returning contacts", () => {
    const existing = existingContact();
    const rows = buildMergedContactRows(
      [
        {
          id: "100",
          fullName: "Jane Doe",
          email: null,
          phones: ["+15551234567"],
          tags: ["upsurge.probate.ai", "new-crm-tag"],
        },
      ],
      new Map([[existing.crm_contact_id, existing]]),
      "ws-1"
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attempt_count, 2);
    assert.equal(rows[0].last_called_on, "2026-06-24");
    assert.equal(rows[0].next_eligible_on, "2026-06-28");
    assert.equal(rows[0].is_terminal, false);
    assert.deepEqual(rows[0].tags, ["upsurge.probate.ai", "new-crm-tag"]);
  });

  it("defaults new CRM contacts to fresh cadence state", () => {
    const rows = buildMergedContactRows(
      [
        {
          id: "200",
          fullName: "New Lead",
          email: "n@example.com",
          phones: ["+15559876543"],
          tags: ["upsurge.probate.ai"],
        },
      ],
      new Map(),
      "ws-1"
    );
    assert.equal(rows[0].attempt_count, 0);
    assert.equal(rows[0].last_called_on, null);
    assert.equal(rows[0].next_eligible_on, null);
    assert.equal(rows[0].is_terminal, false);
  });
});

describe("stripEnrollTagFromTags", () => {
  it("removes only the enroll tag", () => {
    const out = stripEnrollTagFromTags(
      ["Import", "upsurge.probate.ai", "upsurge-noanswer-ai"],
      "upsurge.probate.ai"
    );
    assert.deepEqual(out, ["Import", "upsurge-noanswer-ai"]);
  });
});

describe("enrolledCrmIds", () => {
  it("collects CRM ids from scan result", () => {
    const ids = enrolledCrmIds([
      { id: "1", fullName: null, email: null, phones: [], tags: [] },
      { id: "2", fullName: null, email: null, phones: [], tags: [] },
    ]);
    assert.deepEqual([...ids], ["1", "2"]);
  });
});

describe("findUnenrolledPendingQueueRows", () => {
  it("cancels pending rows for contacts absent from CRM scan", () => {
    const rows = [
      { id: "r1", contact_id: "a", status: "pending", queue_day: "2026-06-30" },
      { id: "r2", contact_id: "b", status: "pending", queue_day: "2026-06-25" },
      { id: "r3", contact_id: "c", status: "dialing", queue_day: "2026-06-25" },
    ];
    const stale = findUnenrolledPendingQueueRows(rows, new Set(["a"]));
    assert.deepEqual(
      stale.map((r) => r.id),
      ["r2"]
    );
  });
});

describe("excludeActiveQueuedContacts", () => {
  it("prevents double-queue for contacts already waiting", () => {
    const eligible = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const filtered = excludeActiveQueuedContacts(eligible, new Set(["b"]));
    assert.deepEqual(
      filtered.map((c) => c.id),
      ["a", "c"]
    );
  });
});
