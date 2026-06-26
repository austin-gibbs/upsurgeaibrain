import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateReporting, type NormalizedCallRow } from "./aggregate";
import { normalizeStoredCall, type StoredCallJoinRow } from "./normalize";
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

  it("does not count no-answer voicemail duration as an answered call", () => {
    const result = aggregateReporting([
      sampleCall({
        outcome: "no_answer_voicemail",
        inVoicemail: true,
        durationSeconds: 45,
        callSuccessful: false,
        disconnectionReason: "voicemail_reached",
      }),
    ]);

    assert.equal(result.kpis.connectedCalls, 0);
    assert.equal(result.kpis.answerRate, 0);
    assert.equal(result.kpis.voicemailRate, 1);
  });
});

describe("normalizeStoredCall", () => {
  it("builds dashboard rows from persisted Retell webhook payloads", () => {
    const row: StoredCallJoinRow = {
      id: "db_call_1",
      retell_call_id: "call_raw",
      agent_id: "agent_1",
      crm_contact_id: "crm_1",
      contact_name: "DB Name",
      contact_email: "db@example.com",
      to_number: "+15559876543",
      outcome: null,
      in_voicemail: null,
      summary: null,
      completed_at: "2026-06-01T14:05:00Z",
      direction: "outbound",
      queued_at: "2026-06-01T14:00:00Z",
      dialed_at: "2026-06-01T14:01:00Z",
      raw_payload: {
        event: "call_analyzed",
        call: {
          call_id: "call_raw",
          direction: "outbound",
          start_timestamp: new Date("2026-06-01T14:01:00Z").getTime(),
          duration_ms: 90_000,
          from_number: "+15551234567",
          to_number: "+15559876543",
          recording_url: "https://example.com/raw.mp3",
          disconnection_reason: "agent_hangup",
          call_analysis: {
            call_summary: "Retell summary",
            call_successful: true,
            user_sentiment: "Positive",
            custom_analysis_data: {
              call_outcome: "appointment",
              caller_full_name: "Retell Name",
              caller_email: "retell@example.com",
            },
          },
          call_cost: {
            combined_cost: 0.34,
            total_duration_seconds: 90,
          },
          latency: {
            e2e: { p50: 700, p90: 1100 },
          },
        },
      },
    };

    const normalized = normalizeStoredCall(
      row,
      new Map([
        [
          "agent_1",
          {
            id: "agent_1",
            name: "Seller Agent",
            retell_agent_id: "retell_agent_1",
            direction: "outbound",
          },
        ],
      ])
    );

    assert.equal(normalized.retellCallId, "call_raw");
    assert.equal(normalized.agentName, "Seller Agent");
    assert.equal(normalized.durationSeconds, 90);
    assert.equal(normalized.recordingUrl, "https://example.com/raw.mp3");
    assert.equal(normalized.summary, "Retell summary");
    assert.equal(normalized.outcome, "appointment");
    assert.equal(normalized.callSuccessful, true);
    assert.equal(normalized.contactName, "Retell Name");
    assert.equal(normalized.contactEmail, "retell@example.com");
    assert.equal(normalized.cost, 0.34);
    assert.equal(normalized.latencyP50Ms, 700);
    assert.equal(normalized.latencyP90Ms, 1100);
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
