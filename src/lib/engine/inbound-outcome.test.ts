import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyInboundOutcome,
  inboundOutcomeLabel,
  resolveInboundRoute,
} from "./inbound-outcome";
import type { AgentInboundConfig, AgentInboundRoute } from "@/types";

describe("classifyInboundOutcome", () => {
  it("maps aliases to canonical inbound outcomes", () => {
    assert.equal(classifyInboundOutcome({ rawOutcome: "booked" }), "appointment_booked");
    assert.equal(classifyInboundOutcome({ rawOutcome: "Hot Lead" }), "hot_lead");
    assert.equal(classifyInboundOutcome({ rawOutcome: "wrong-number" }), "wrong_number");
    assert.equal(classifyInboundOutcome({ rawOutcome: "interested_no_appointment" }), "interested");
  });

  it("falls back to unknown for empty or unrecognized values", () => {
    assert.equal(classifyInboundOutcome({ rawOutcome: null }), "unknown");
    assert.equal(classifyInboundOutcome({ rawOutcome: "" }), "unknown");
    assert.equal(classifyInboundOutcome({ rawOutcome: "totally_new_thing" }), "unknown");
  });
});

describe("inboundOutcomeLabel", () => {
  it("returns human-readable labels", () => {
    assert.equal(inboundOutcomeLabel("appointment_booked"), "Appointment Booked");
    assert.equal(inboundOutcomeLabel("hot_lead"), "Hot Lead");
  });
});

describe("resolveInboundRoute", () => {
  const config: Pick<
    AgentInboundConfig,
    | "default_pipeline_id"
    | "default_pipeline_stage_id"
    | "default_pipeline_name"
    | "default_stage_name"
  > = {
    default_pipeline_id: "pipe-default",
    default_pipeline_stage_id: "stage-default",
    default_pipeline_name: "Default Pipe",
    default_stage_name: "New Lead",
  };

  const routes: AgentInboundRoute[] = [
    {
      id: "r1",
      agent_id: "a1",
      outcome: "appointment_booked",
      pipeline_id: "pipe-appt",
      pipeline_stage_id: "stage-appt",
      pipeline_name: "Sales",
      stage_name: "Booked",
      opportunity_status: "open",
      tag: "booked-tag",
      remove_tags: ["old-tag"],
    },
    {
      id: "r2",
      agent_id: "a1",
      outcome: "*",
      pipeline_id: "pipe-catch",
      pipeline_stage_id: "stage-catch",
      pipeline_name: "Sales",
      stage_name: "Inbound",
      opportunity_status: null,
      tag: "catch-tag",
      remove_tags: [],
    },
  ];

  it("prefers exact outcome over catch-all", () => {
    const resolved = resolveInboundRoute(routes, "appointment_booked", config);
    assert.equal(resolved.source, "exact");
    assert.equal(resolved.pipelineId, "pipe-appt");
    assert.equal(resolved.stageId, "stage-appt");
    assert.equal(resolved.tag, "booked-tag");
    assert.deepEqual(resolved.removeTags, ["old-tag"]);
  });

  it("falls back to '*' catch-all when no exact match", () => {
    const resolved = resolveInboundRoute(routes, "spam", config);
    assert.equal(resolved.source, "catch_all");
    assert.equal(resolved.pipelineId, "pipe-catch");
    assert.equal(resolved.tag, "catch-tag");
  });

  it("falls back to config default when no routes match", () => {
    const resolved = resolveInboundRoute([], "interested", config);
    assert.equal(resolved.source, "config_default");
    assert.equal(resolved.pipelineId, "pipe-default");
    assert.equal(resolved.stageId, "stage-default");
    assert.equal(resolved.tag, null);
  });

  it("returns none when nothing is configured", () => {
    const resolved = resolveInboundRoute([], "interested", null);
    assert.equal(resolved.source, "none");
    assert.equal(resolved.pipelineId, null);
  });
});
