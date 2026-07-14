import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedCallRow } from "./aggregate";
import {
  applyOverviewInterval,
  bucketCallsOverTimeWeekly,
  buildOverview,
  pickReferenceTimezone,
  type OverviewAgentMeta,
  type OverviewWorkspaceMeta,
} from "./overview";

function sampleCall(
  overrides: Partial<NormalizedCallRow> & { workspaceId: string }
): NormalizedCallRow & { workspaceId: string } {
  const { workspaceId, ...rest } = overrides;
  return {
    retellCallId: "call_1",
    agentId: "agent_1",
    agentName: "Test Agent",
    direction: "outbound",
    startTimestamp: new Date("2026-06-03T14:00:00Z").getTime(), // Wed
    completedAt: "2026-06-03T14:05:00Z",
    durationSeconds: 120,
    fromNumber: "+15551234567",
    toNumber: "+15559876543",
    phone: "+15559876543",
    contactName: "Jane Doe",
    contactEmail: "jane@example.com",
    crmContactId: "12345",
    recordingUrl: null,
    summary: "Booked appointment",
    outcome: "appointment",
    callSuccessful: true,
    userSentiment: "Positive",
    inVoicemail: false,
    disconnectionReason: "agent_hangup",
    cost: 0.42,
    latencyP50Ms: 800,
    latencyP90Ms: 1200,
    ...rest,
    workspaceId,
  };
}

const workspaces: OverviewWorkspaceMeta[] = [
  {
    id: "ws_a",
    name: "Alpha Realty",
    timezone: "America/Denver",
    crm_provider: "followupboss",
    is_active: true,
  },
  {
    id: "ws_b",
    name: "Beta Group",
    timezone: "America/Los_Angeles",
    crm_provider: "highlevel",
    is_active: false,
  },
];

const agents: OverviewAgentMeta[] = [
  {
    id: "agent_1",
    name: "Seller Outbound",
    status: "active",
    direction: "outbound",
    retell_agent_id: "retell_1",
    workspace_id: "ws_a",
  },
  {
    id: "agent_2",
    name: "Buyer Inbound",
    status: "draft",
    direction: "inbound",
    retell_agent_id: "retell_2",
    workspace_id: "ws_a",
  },
  {
    id: "agent_3",
    name: "Nurture",
    status: "active",
    direction: "outbound",
    retell_agent_id: "retell_3",
    workspace_id: "ws_b",
  },
];

describe("pickReferenceTimezone", () => {
  it("picks the most common timezone", () => {
    assert.equal(
      pickReferenceTimezone([
        ...workspaces,
        {
          id: "ws_c",
          name: "Charlie",
          timezone: "America/Denver",
          crm_provider: "highlevel",
          is_active: true,
        },
      ]),
      "America/Denver"
    );
  });

  it("falls back when empty", () => {
    assert.equal(pickReferenceTimezone([]), "America/Denver");
  });
});

describe("bucketCallsOverTimeWeekly", () => {
  it("collapses daily points into ISO week starts (Monday)", () => {
    const weekly = bucketCallsOverTimeWeekly([
      { date: "2026-06-01", inbound: 1, outbound: 2, total: 3 }, // Mon
      { date: "2026-06-03", inbound: 0, outbound: 4, total: 4 }, // Wed same week
      { date: "2026-06-08", inbound: 2, outbound: 0, total: 2 }, // next Mon
    ]);
    assert.equal(weekly.length, 2);
    assert.equal(weekly[0].date, "2026-06-01");
    assert.equal(weekly[0].inbound, 1);
    assert.equal(weekly[0].outbound, 6);
    assert.equal(weekly[0].total, 7);
    assert.equal(weekly[1].date, "2026-06-08");
    assert.equal(weekly[1].total, 2);
  });
});

describe("applyOverviewInterval", () => {
  it("passthrough for daily", () => {
    const base = {
      kpis: {
        totalCalls: 1,
        inboundCalls: 0,
        outboundCalls: 1,
        connectedCalls: 1,
        answerRate: 1,
        voicemailRate: 0,
        successRate: 1,
        appointmentCount: 1,
        avgDurationSeconds: 60,
        totalDurationSeconds: 60,
        totalCost: 0.1,
        avgCost: 0.1,
        sentimentPositive: 1,
        sentimentNeutral: 0,
        sentimentNegative: 0,
        latencyP50Ms: null,
        latencyP90Ms: null,
      },
      callsOverTime: [
        { date: "2026-06-01", inbound: 0, outbound: 1, total: 1 },
        { date: "2026-06-02", inbound: 0, outbound: 1, total: 1 },
      ],
      outcomeBreakdown: [],
      sentimentBreakdown: [],
      disconnectionBreakdown: [],
      heatmap: [],
      latencyOverTime: [],
    };
    const result = applyOverviewInterval(base, "daily");
    assert.equal(result.callsOverTime.length, 2);
  });

  it("re-buckets for weekly", () => {
    const base = {
      kpis: {
        totalCalls: 2,
        inboundCalls: 0,
        outboundCalls: 2,
        connectedCalls: 2,
        answerRate: 1,
        voicemailRate: 0,
        successRate: 1,
        appointmentCount: 0,
        avgDurationSeconds: 60,
        totalDurationSeconds: 120,
        totalCost: 0.2,
        avgCost: 0.1,
        sentimentPositive: 0,
        sentimentNeutral: 0,
        sentimentNegative: 0,
        latencyP50Ms: null,
        latencyP90Ms: null,
      },
      callsOverTime: [
        { date: "2026-06-01", inbound: 0, outbound: 1, total: 1 },
        { date: "2026-06-02", inbound: 0, outbound: 1, total: 1 },
      ],
      outcomeBreakdown: [],
      sentimentBreakdown: [],
      disconnectionBreakdown: [],
      heatmap: [],
      latencyOverTime: [],
    };
    const result = applyOverviewInterval(base, "weekly");
    assert.equal(result.callsOverTime.length, 1);
    assert.equal(result.callsOverTime[0].total, 2);
  });
});

describe("buildOverview", () => {
  it("rolls up global KPIs and per-workspace / per-agent slices", () => {
    const calls = [
      sampleCall({
        workspaceId: "ws_a",
        agentId: "agent_1",
        retellCallId: "c1",
        startTimestamp: new Date("2026-06-03T15:00:00Z").getTime(),
      }),
      sampleCall({
        workspaceId: "ws_a",
        agentId: "agent_2",
        retellCallId: "c2",
        direction: "inbound",
        outcome: "no_answer_voicemail",
        callSuccessful: false,
        inVoicemail: true,
        cost: 0.1,
        startTimestamp: new Date("2026-06-04T15:00:00Z").getTime(),
      }),
      sampleCall({
        workspaceId: "ws_b",
        agentId: "agent_3",
        retellCallId: "c3",
        cost: 0.25,
        outcome: "interested",
        startTimestamp: new Date("2026-06-05T15:00:00Z").getTime(),
      }),
    ];

    const result = buildOverview(calls, workspaces, agents);

    assert.equal(result.totals.workspaceCount, 2);
    assert.equal(result.totals.activeWorkspaceCount, 1);
    assert.equal(result.totals.agentCount, 3);
    assert.equal(result.totals.activeAgentCount, 2);
    assert.equal(result.totals.totalCalls, 3);
    assert.equal(result.global.kpis.inboundCalls, 1);
    assert.equal(result.global.kpis.outboundCalls, 2);
    assert.equal(result.global.kpis.appointmentCount, 1);
    assert.ok(Math.abs(result.totals.totalCost - 0.77) < 0.001);

    assert.equal(result.workspaces.length, 2);
    // Sorted by totalCalls desc — ws_a has 2 calls
    assert.equal(result.workspaces[0].id, "ws_a");
    assert.equal(result.workspaces[0].kpis.totalCalls, 2);
    assert.equal(result.workspaces[0].agentCount, 2);
    assert.equal(result.workspaces[0].activeAgents, 1);

    const agent1 = result.workspaces[0].agents.find((a) => a.id === "agent_1");
    const agent2 = result.workspaces[0].agents.find((a) => a.id === "agent_2");
    assert.equal(agent1?.calls, 1);
    assert.equal(agent2?.calls, 1);

    assert.equal(result.workspaces[1].id, "ws_b");
    assert.equal(result.workspaces[1].kpis.totalCalls, 1);
  });

  it("returns empty global aggregates with zero-call workspaces", () => {
    const result = buildOverview([], workspaces, agents);
    assert.equal(result.totals.totalCalls, 0);
    assert.equal(result.workspaces.length, 2);
    // Tied on calls → alphabetical
    assert.equal(result.workspaces[0].id, "ws_a");
    assert.equal(result.workspaces[0].kpis.totalCalls, 0);
    assert.equal(result.referenceTimezone, "America/Denver");
  });
});
