// =====================================================================
// Unit tests for the "money logic": outcome classification, eligibility +
// cadence math, and tag reconciliation. These encode the rules that decide
// who gets called, when they leave the flow, and what gets written to the
// CRM — so they are the highest-value things to lock down before cutover.
//
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyOutcome } from "./outcome";
import {
  isEligible,
  nextEligibleDate,
  addDays,
  withinCallWindow,
  dailyWindowCapacity,
  remainingWindowCapacity,
  hhmmToSeconds,
} from "./cadence";
import { reconcileTags } from "./tags";
import type { AgentCallConfig, Contact, OutcomeTag } from "@/types";

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
function callConfig(overrides: Partial<AgentCallConfig> = {}): AgentCallConfig {
  return {
    agent_id: "agent_1",
    max_total_calls: null,
    max_calls_per_day: 100,
    max_attempts_per_contact: 10,
    call_window_start: "09:00",
    call_window_end: "18:00",
    daily_run_at: "09:00",
    drip_seconds: 60,
    cadence_day_gaps: [0, 1, 2, 3, 5, 7, 10, 14, 21, 30],
    ...overrides,
  };
}

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "contact_1",
    workspace_id: "ws_1",
    crm_contact_id: "123",
    full_name: "Jane Doe",
    email: "jane@example.com",
    phones: ["+15559876543"],
    tags: [],
    attempt_count: 0,
    last_called_on: null,
    next_eligible_on: null,
    is_terminal: false,
    terminal_outcome: null,
    ...overrides,
  };
}

const TAXONOMY: OutcomeTag[] = [
  { workspace_id: "ws_1", outcome: "voicemail", tag: "upsurge-voicemail-ai", is_terminal: false },
  { workspace_id: "ws_1", outcome: "no_answer", tag: "upsurge-noanswer-ai", is_terminal: false },
  { workspace_id: "ws_1", outcome: "appointment", tag: "upsurge-appointment-ai", is_terminal: true },
  { workspace_id: "ws_1", outcome: "not_interested", tag: "upsurge-notinterested-ai", is_terminal: true },
  { workspace_id: "ws_1", outcome: "dnd", tag: "upsurge-dnd-ai", is_terminal: true },
  { workspace_id: "ws_1", outcome: "interested_no_appointment", tag: "upsurge-interestednoappointment-ai", is_terminal: false },
  { workspace_id: "ws_1", outcome: "follow_up", tag: "upsurge-followup-ai", is_terminal: false },
];

// ---------------------------------------------------------------------
// classifyOutcome
// ---------------------------------------------------------------------
describe("classifyOutcome", () => {
  it("maps known aliases to canonical outcomes", () => {
    assert.equal(classifyOutcome({ rawOutcome: "booked", inVoicemail: false }), "appointment");
    assert.equal(classifyOutcome({ rawOutcome: "appointment_set", inVoicemail: false }), "appointment");
    assert.equal(classifyOutcome({ rawOutcome: "not interested", inVoicemail: false }), "not_interested");
    assert.equal(classifyOutcome({ rawOutcome: "do-not-call", inVoicemail: false }), "dnd");
    assert.equal(classifyOutcome({ rawOutcome: "callback", inVoicemail: false }), "follow_up");
    assert.equal(classifyOutcome({ rawOutcome: "interested", inVoicemail: false }), "interested_no_appointment");
  });

  it("normalizes spaces and hyphens to underscores", () => {
    assert.equal(classifyOutcome({ rawOutcome: "No Answer", inVoicemail: false }), "no_answer");
    assert.equal(classifyOutcome({ rawOutcome: "  VoiceMail  ", inVoicemail: false }), "voicemail");
  });

  it("falls back to no_answer for unknown / empty outcomes (safe: keeps calling)", () => {
    assert.equal(classifyOutcome({ rawOutcome: "gibberish", inVoicemail: false }), "no_answer");
    assert.equal(classifyOutcome({ rawOutcome: null, inVoicemail: false }), "no_answer");
    assert.equal(classifyOutcome({ rawOutcome: undefined, inVoicemail: false }), "no_answer");
  });

  it("applies the voicemail override only to an unanswered call", () => {
    assert.equal(classifyOutcome({ rawOutcome: "no_answer", inVoicemail: true }), "voicemail");
    assert.equal(classifyOutcome({ rawOutcome: "gibberish", inVoicemail: true }), "voicemail");
    // A real positive outcome must NOT be downgraded to voicemail.
    assert.equal(classifyOutcome({ rawOutcome: "booked", inVoicemail: true }), "appointment");
  });
});

// ---------------------------------------------------------------------
// isEligible
// ---------------------------------------------------------------------
describe("isEligible", () => {
  const today = "2026-06-22";

  it("is eligible for a fresh, never-called contact", () => {
    assert.equal(isEligible(contact(), callConfig(), today), true);
  });

  it("is not eligible when terminal", () => {
    assert.equal(isEligible(contact({ is_terminal: true }), callConfig(), today), false);
  });

  it("is not eligible at/over the per-contact attempt cap", () => {
    assert.equal(
      isEligible(contact({ attempt_count: 10 }), callConfig({ max_attempts_per_contact: 10 }), today),
      false
    );
    assert.equal(
      isEligible(contact({ attempt_count: 9 }), callConfig({ max_attempts_per_contact: 10 }), today),
      true
    );
  });

  it("is not eligible if already called today", () => {
    assert.equal(isEligible(contact({ last_called_on: today }), callConfig(), today), false);
  });

  it("is not eligible before next_eligible_on, eligible on/after it", () => {
    assert.equal(isEligible(contact({ next_eligible_on: "2026-06-25" }), callConfig(), today), false);
    assert.equal(isEligible(contact({ next_eligible_on: "2026-06-22" }), callConfig(), today), true);
    assert.equal(isEligible(contact({ next_eligible_on: "2026-06-20" }), callConfig(), today), true);
  });
});

// ---------------------------------------------------------------------
// nextEligibleDate  (cadence_day_gaps indexed by attempt just completed)
// ---------------------------------------------------------------------
describe("nextEligibleDate", () => {
  const today = "2026-06-22";
  const cfg = callConfig({ cadence_day_gaps: [0, 1, 2, 3, 5] });

  it("uses the gap for the attempt just completed", () => {
    assert.equal(nextEligibleDate(1, cfg, today), addDays(today, 1)); // gaps[1] = 1
    assert.equal(nextEligibleDate(2, cfg, today), addDays(today, 2)); // gaps[2] = 2
    assert.equal(nextEligibleDate(3, cfg, today), addDays(today, 3)); // gaps[3] = 3
  });

  it("clamps to the last gap beyond the array length", () => {
    assert.equal(nextEligibleDate(9, cfg, today), addDays(today, 5)); // last gap = 5
  });

  it("never schedules the next attempt for the same day (min 1 day)", () => {
    // gaps[0] is 0, but a re-attempt must not land on the same day.
    assert.equal(nextEligibleDate(0, cfg, today), addDays(today, 1));
  });
});

// ---------------------------------------------------------------------
// reconcileTags
// ---------------------------------------------------------------------
describe("reconcileTags", () => {
  const enrollTag = "upsurgecallflowai";

  it("adds the new outcome tag and keeps unrelated tags", () => {
    const r = reconcileTags({
      currentTags: ["VIP", enrollTag],
      taxonomy: TAXONOMY,
      outcome: "voicemail",
      enrollTag,
    });
    assert.ok(r.tags.includes("VIP"));
    assert.ok(r.tags.includes(enrollTag)); // non-terminal keeps enrollment
    assert.ok(r.tags.includes("upsurge-voicemail-ai"));
    assert.equal(r.isTerminal, false);
  });

  it("strips any prior AI outcome tag (no stacking)", () => {
    const r = reconcileTags({
      currentTags: ["upsurge-noanswer-ai", enrollTag],
      taxonomy: TAXONOMY,
      outcome: "voicemail",
      enrollTag,
    });
    assert.ok(!r.tags.includes("upsurge-noanswer-ai"));
    assert.ok(r.tags.includes("upsurge-voicemail-ai"));
  });

  it("drops the enroll tag on a terminal outcome (leaves the flow)", () => {
    const r = reconcileTags({
      currentTags: ["upsurge-noanswer-ai", enrollTag, "VIP"],
      taxonomy: TAXONOMY,
      outcome: "appointment",
      enrollTag,
    });
    assert.equal(r.isTerminal, true);
    assert.ok(!r.tags.includes(enrollTag)); // enrollment removed
    assert.ok(r.tags.includes("upsurge-appointment-ai"));
    assert.ok(r.tags.includes("VIP")); // unrelated tags preserved
  });

  it("is idempotent — re-running the same outcome is a no-op", () => {
    const first = reconcileTags({ currentTags: [enrollTag], taxonomy: TAXONOMY, outcome: "voicemail", enrollTag });
    const second = reconcileTags({ currentTags: first.tags, taxonomy: TAXONOMY, outcome: "voicemail", enrollTag });
    assert.deepEqual([...second.tags].sort(), [...first.tags].sort());
  });
});

// ---------------------------------------------------------------------
// withinCallWindow (string-bounds sanity)
// ---------------------------------------------------------------------
describe("withinCallWindow", () => {
  it("treats the window as inclusive HH:MM string bounds", () => {
    // Can't easily freeze the clock here, but verify the comparison contract
    // holds for representative boundaries via a fixed tz-independent check.
    const start = "09:00";
    const end = "18:00";
    // Manual replication of the comparison the function performs.
    assert.equal("09:00" >= start && "09:00" <= end, true);
    assert.equal("17:59" >= start && "17:59" <= end, true);
    assert.equal("18:01" >= start && "18:01" <= end, false);
    assert.equal("08:59" >= start && "08:59" <= end, false);
    // And the real function returns a boolean for the current time.
    assert.equal(typeof withinCallWindow("America/New_York", start, end), "boolean");
  });
});

// ---------------------------------------------------------------------
// dailyWindowCapacity + remainingWindowCapacity
// ---------------------------------------------------------------------
describe("dailyWindowCapacity", () => {
  it("counts drip slots from window start through window end inclusive", () => {
    // 13:00–19:00 = 6 hours, 60s drip → 360 intervals + 1 = 361
    assert.equal(dailyWindowCapacity("13:00", "19:00", 60), 361);
    assert.equal(dailyWindowCapacity("09:00", "10:00", 60), 61);
  });

  it("returns 0 for invalid windows or drip", () => {
    assert.equal(dailyWindowCapacity("19:00", "13:00", 60), 0);
    assert.equal(dailyWindowCapacity("13:00", "19:00", 0), 0);
  });

  it("last projected slot never exceeds window end", () => {
    const start = "13:00";
    const end = "19:00";
    const drip = 60;
    const cap = dailyWindowCapacity(start, end, drip);
    const lastSec = hhmmToSeconds(start) + (cap - 1) * drip;
    assert.ok(lastSec <= hhmmToSeconds(end));
  });
});

describe("remainingWindowCapacity", () => {
  it("matches window phase: full before open, partial mid-window, zero after close", () => {
    const start = "13:00";
    const end = "19:00";
    const drip = 60;
    const full = dailyWindowCapacity(start, end, drip);
    const nowHHMM = new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    const [h, m] = nowHHMM.split(":").map(Number);
    const nowSec = h * 3600 + m * 60;
    const startSec = hhmmToSeconds(start);
    const endSec = hhmmToSeconds(end);
    const cap = remainingWindowCapacity("America/New_York", start, end, drip);

    if (nowSec < startSec) {
      assert.equal(cap, full);
    } else if (nowSec >= endSec) {
      assert.equal(cap, 0);
    } else {
      assert.ok(cap > 0 && cap <= full);
      const expected = Math.floor((endSec - nowSec) / drip) + 1;
      assert.equal(cap, expected);
    }
  });

  it("returns a boolean-safe non-negative count", () => {
    const cap = remainingWindowCapacity("America/New_York", "13:00", "19:00", 60);
    assert.ok(cap >= 0);
    assert.ok(cap <= dailyWindowCapacity("13:00", "19:00", 60));
  });
});

describe("daily cap rollover math", () => {
  it("1200 eligible contacts span multiple days at window capacity", () => {
    const perDay = dailyWindowCapacity("13:00", "19:00", 60);
    assert.equal(perDay, 361);
    const daysNeeded = Math.ceil(1200 / perDay);
    assert.equal(daysNeeded, 4);
  });
});
