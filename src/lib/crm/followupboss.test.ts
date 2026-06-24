import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapFubCallOutcome } from "./followupboss";

describe("mapFubCallOutcome", () => {
  it("maps follow_up and appointment to Interested", () => {
    assert.equal(mapFubCallOutcome("follow_up", false), "Interested");
    assert.equal(mapFubCallOutcome("appointment", false), "Interested");
  });

  it("maps terminal declines to Not Interested", () => {
    assert.equal(mapFubCallOutcome("not_interested", false), "Not Interested");
    assert.equal(mapFubCallOutcome("dnd", false), "Not Interested");
  });

  it("maps no_answer_voicemail based on voicemail flag", () => {
    assert.equal(mapFubCallOutcome("no_answer_voicemail", true), "Left Message");
    assert.equal(mapFubCallOutcome("no_answer_voicemail", false), "No Answer");
  });

  it("returns undefined for unknown outcomes when not voicemail", () => {
    assert.equal(mapFubCallOutcome("custom_outcome", false), undefined);
    assert.equal(mapFubCallOutcome("custom_outcome", true), "Left Message");
  });
});
