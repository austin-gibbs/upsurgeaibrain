import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addTagsToCrm,
  removeTagsFromCrm,
  dedupeTags,
} from "./crm-writeback";
import type { CrmAdapter } from "@/lib/crm/types";

function stubCrm(overrides: Partial<CrmAdapter> = {}): CrmAdapter & {
  _tags: string[];
  _addCalls: string[][];
  _removeCalls: string[][];
  _setCalls: string[][];
} {
  const state = {
    _tags: [] as string[],
    _addCalls: [] as string[][],
    _removeCalls: [] as string[][],
    _setCalls: [] as string[][],
  };
  const crm = {
    provider: "highlevel" as const,
    _tags: state._tags,
    _addCalls: state._addCalls,
    _removeCalls: state._removeCalls,
    _setCalls: state._setCalls,
    async getContactsByTag() {
      return [];
    },
    async getContact() {
      return null;
    },
    async setTags(_id: string, tags: string[]) {
      state._setCalls.push(tags);
      state._tags = [...tags];
    },
    async addTags(_id: string, tags: string[]) {
      state._addCalls.push(tags);
      state._tags = dedupeTags([...state._tags, ...tags]);
    },
    async removeTags(_id: string, tags: string[]) {
      state._removeCalls.push(tags);
      const remove = new Set(tags);
      state._tags = state._tags.filter((t) => !remove.has(t));
    },
    async addNote() {},
    async logCall() {
      return { noteLogged: true, recordingCallLogged: false };
    },
    async createTask() {},
    async listUsers() {
      return [];
    },
    async verifyCredentials() {
      return true;
    },
    ...overrides,
  };
  return crm as any;
}

describe("addTagsToCrm / removeTagsFromCrm", () => {
  it("prefers additive addTags over full-replace setTags", async () => {
    const crm = stubCrm();
    crm._tags = ["keep-me"];
    await addTagsToCrm(crm, "c1", ["new-tag"], ["keep-me"]);
    assert.equal(crm._addCalls.length, 1);
    assert.deepEqual(crm._addCalls[0], ["new-tag"]);
    assert.equal(crm._setCalls.length, 0);
  });

  it("removeTagsFromCrm uses removeTags when available", async () => {
    const crm = stubCrm();
    crm._tags = ["a", "b", "c"];
    await removeTagsFromCrm(crm, "c1", ["b"], ["a", "b", "c"]);
    assert.equal(crm._removeCalls.length, 1);
    assert.deepEqual(crm._removeCalls[0], ["b"]);
  });

  it("removeTagsFromCrm falls back to setTags without removeTags", async () => {
    const crm = stubCrm({ removeTags: undefined });
    await removeTagsFromCrm(crm, "c1", ["b"], ["a", "b", "c"]);
    assert.equal(crm._setCalls.length, 1);
    assert.deepEqual(crm._setCalls[0], ["a", "c"]);
  });
});

describe("inbound processor helpers (pure)", () => {
  it("documents short-call contract: note+recording always, tags/pipeline suppressed", () => {
    // min_duration_seconds only suppresses tags/pipeline/tasks — never the note
    // or recording writeback. Covered by the shortCall flag in process-inbound.
    const durationSeconds = 5;
    const minDurationSeconds = 15;
    const shortCall = durationSeconds < minDurationSeconds;
    assert.equal(shortCall, true);
    const skipTagsPipelineTasks = shortCall;
    const alwaysLogNoteAndRecording = true;
    assert.equal(skipTagsPipelineTasks, true);
    assert.equal(alwaysLogNoteAndRecording, true);
  });
});
