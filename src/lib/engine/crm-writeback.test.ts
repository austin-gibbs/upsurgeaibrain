import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noteWithRecording, summarizeCrmErrors } from "./crm-writeback";

describe("noteWithRecording", () => {
  it("appends recording URL when present", () => {
    const note = "AI Agent: Test\nSummary: hello";
    const out = noteWithRecording(note, "https://example.com/rec.wav");
    assert.match(out, /Recording: https:\/\/example\.com\/rec\.wav/);
    assert.ok(out.startsWith(note));
  });

  it("returns note unchanged when recording URL is absent", () => {
    const note = "AI Agent: Test";
    assert.equal(noteWithRecording(note, null), note);
    assert.equal(noteWithRecording(note, ""), note);
    assert.equal(noteWithRecording(note, "  "), note);
  });
});

describe("summarizeCrmErrors", () => {
  it("joins errors and truncates long messages", () => {
    assert.equal(summarizeCrmErrors([]), null);
    assert.equal(summarizeCrmErrors(["logCall: 401", "addNote: 500"]), "logCall: 401 | addNote: 500");
    const long = summarizeCrmErrors(["x".repeat(3000)]);
    assert.ok(long && long.length <= 2000);
  });
});
