import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateReporting, type NormalizedCallRow } from "./aggregate";
import { crmContactUrl, normalizeCrmAccountUrl } from "../crm/url";

function sampleCall(overrides: Partial<NormalizedCallRow> = {}): NormalizedCallRow {
  return {
    retellCallId: "call_1",
    agentId: "agent_1",
    agentName: "Test Agent",
    direction: "outbound",
    startTimestamp: new Date("2026-06-01T14:00:00Z").getTime(),
    completedAt: "2026-06-01T14:05:00Z",
    durationSeconds: 120,
    fromNumber: "+15551234567",
    toNumber: "+15559876543",
    phone: "+15559876543",
    contactName: "Jane Doe",
    contactEmail: "jane@example.com",
    crmContactId: "12345",
    recordingUrl: "https://example.com/rec.mp3",
    summary: "Booked appointment",
    outcome: "appointment",
    callSuccessful: true,
    userSentiment: "Positive",
    inVoicemail: false,
    disconnectionReason: "agent_hangup",
    cost: 0.42,
    latencyP50Ms: 800,
    latencyP90Ms: 1200,
    ...overrides,
  };
}

describe("aggregateReporting", () => {
  it("computes KPI totals from normalized calls", () => {
    const calls = [
      sampleCall(),
      sampleCall({
        retellCallId: "call_2",
        direction: "inbound",
        callSuccessful: false,
        inVoicemail: true,
        outcome: "no_answer_voicemail",
        userSentiment: "Negative",
        cost: 0.18,
      }),
    ];
    const result = aggregateReporting(calls);
    assert.equal(result.kpis.totalCalls, 2);
    assert.equal(result.kpis.inboundCalls, 1);
    assert.equal(result.kpis.outboundCalls, 1);
    assert.equal(result.kpis.appointmentCount, 1);
    assert.equal(result.kpis.totalCost, 0.6);
    assert.ok(result.kpis.answerRate > 0);
    assert.ok(result.callsOverTime.length >= 1);
    assert.ok(result.outcomeBreakdown.length >= 1);
  });

  it("returns empty aggregates for no calls", () => {
    const result = aggregateReporting([]);
    assert.equal(result.kpis.totalCalls, 0);
    assert.equal(result.kpis.answerRate, 0);
    assert.deepEqual(result.callsOverTime, []);
  });
});

describe("crmContactUrl", () => {
  it("normalizes trailing slashes on base URL", () => {
    assert.equal(
      normalizeCrmAccountUrl("https://nilpatel.followupboss.com/"),
      "https://nilpatel.followupboss.com"
    );
  });

  it("builds FUB contact deep-link", () => {
    assert.equal(
      crmContactUrl("followupboss", "https://nilpatel.followupboss.com", "999"),
      "https://nilpatel.followupboss.com/2/people/view/999"
    );
  });

  it("returns null without contact id or base URL", () => {
    assert.equal(crmContactUrl("followupboss", null, "999"), null);
    assert.equal(
      crmContactUrl("followupboss", "https://nilpatel.followupboss.com", null),
      null
    );
  });
});
