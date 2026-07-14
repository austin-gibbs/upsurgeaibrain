import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CrmAdapter } from "@/lib/crm/types";
import {
  addTagsToCrm,
  logCallToCrm,
  noteWithRecording,
  summarizeCrmErrors,
  tagsMissingFromExisting,
} from "./crm-writeback";

function mockCrm(overrides: Partial<CrmAdapter> = {}): CrmAdapter {
  return {
    provider: "followupboss",
    getContactsByTag: async () => [],
    getContact: async () => null,
    setTags: async () => {},
    addNote: async () => {},
    logCall: async () => ({ noteLogged: true, recordingCallLogged: true }),
    createTask: async () => {},
    listUsers: async () => [],
    verifyCredentials: async () => true,
    ...overrides,
  };
}

const baseInput = {
  contactId: "contact-1",
  phone: "+15551234567",
  note: "AI Agent: Test\nSummary: hello",
  recordingUrl: "https://example.com/rec.wav",
  durationSeconds: 42,
  fromNumber: "+15559876543",
  toNumber: "+15551234567",
  outcome: "follow_up",
  inVoicemail: false,
};

describe("logCallToCrm", () => {
  it("sets recordingLogged when playable call log succeeds", async () => {
    const flags = await logCallToCrm({
      ...baseInput,
      crm: mockCrm({
        logCall: async () => ({ noteLogged: true, recordingCallLogged: true }),
      }),
    });
    assert.equal(flags.noteLogged, true);
    assert.equal(flags.recordingLogged, true);
    assert.deepEqual(flags.crmErrors, []);
  });

  it("records warning and recordingLogged=false when HL note ok but playable call missing", async () => {
    const flags = await logCallToCrm({
      ...baseInput,
      crm: mockCrm({
        logCall: async () => ({
          noteLogged: true,
          recordingCallLogged: false,
          warnings: [
            "playableCall: HIGHLEVEL_CALL_PROVIDER_ID is not set — only a note with recording link was written",
          ],
        }),
      }),
    });
    assert.equal(flags.noteLogged, true);
    assert.equal(flags.recordingLogged, false);
    assert.equal(flags.crmErrors.length, 1);
    assert.match(flags.crmErrors[0], /HIGHLEVEL_CALL_PROVIDER_ID/);
  });

  it("falls back to addNote with recording link when logCall throws", async () => {
    let fallbackNote = "";
    const flags = await logCallToCrm({
      ...baseInput,
      crm: mockCrm({
        logCall: async () => {
          throw new Error("401 unauthorized");
        },
        addNote: async (_id, note) => {
          fallbackNote = note;
        },
      }),
    });
    assert.equal(flags.noteLogged, true);
    assert.equal(flags.recordingLogged, false);
    assert.match(fallbackNote, /Recording: https:\/\/example\.com\/rec\.wav/);
    assert.match(flags.crmErrors.join(" "), /logCall: 401/);
    assert.match(flags.crmErrors.join(" "), /playableCall: primary logCall failed/);
  });

  it("recordingLogged stays false when call had no recording URL", async () => {
    const flags = await logCallToCrm({
      ...baseInput,
      recordingUrl: null,
      crm: mockCrm({
        logCall: async () => ({ noteLogged: true, recordingCallLogged: false }),
      }),
    });
    assert.equal(flags.noteLogged, true);
    assert.equal(flags.recordingLogged, false);
    assert.deepEqual(flags.crmErrors, []);
  });
});

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

describe("addTagsToCrm", () => {
  it("only sends tags missing from the known existing set", async () => {
    let added: string[] = [];
    const result = await addTagsToCrm(
      mockCrm({
        addTags: async (_id, tags) => {
          added = tags;
        },
      }),
      "contact-1",
      ["existing", "new", "new", ""],
      ["existing"]
    );

    assert.deepEqual(result, ["new"]);
    assert.deepEqual(added, ["new"]);
  });

  it("skips the CRM call when no tags are missing", async () => {
    let called = false;
    const result = await addTagsToCrm(
      mockCrm({
        addTags: async () => {
          called = true;
        },
      }),
      "contact-1",
      ["existing"],
      ["existing"]
    );

    assert.deepEqual(result, []);
    assert.equal(called, false);
  });

  it("falls back to setTags with a merged list for CRMs without addTags", async () => {
    let written: string[] = [];
    await addTagsToCrm(
      mockCrm({
        provider: "highlevel",
        setTags: async (_id, tags) => {
          written = tags;
        },
      }),
      "contact-1",
      ["new"],
      ["existing"]
    );

    assert.deepEqual(written, ["existing", "new"]);
  });
});

describe("tagsMissingFromExisting", () => {
  it("dedupes requested tags and filters known existing tags", () => {
    assert.deepEqual(
      tagsMissingFromExisting(
        ["existing", "new", "new", "  ", "another"],
        ["existing"]
      ),
      ["new", "another"]
    );
  });
});
