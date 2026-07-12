import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bullmqJobIdForPhone,
  chainedPhoneJobIds,
  dedupePhones,
  dialPhonesForAttempt,
  shouldContinueToNextPhone,
  shouldFinalizeAttempt,
  shouldStopPhoneSequence,
} from "./multi-phone";
import type { Agent, Contact, Workspace } from "@/types";

const fubWorkspace: Workspace = {
  id: "ws-1",
  organization_id: "org-1",
  name: "Nil Patel Realty",
  timezone: "America/New_York",
  crm_provider: "followupboss",
  crm_credentials_encrypted: "enc",
  crm_status: null,
  crm_status_detail: null,
  crm_account_url: "https://nilpatel.followupboss.com/",
  enroll_tag: "upsurge.probate.ai",
  is_active: true,
  created_by: null,
  created_at: "",
  updated_at: "",
};

const hlWorkspace: Workspace = {
  ...fubWorkspace,
  crm_provider: "highlevel",
};

const agent: Agent = {
  id: "agent-1",
  workspace_id: "ws-1",
  name: "Probate",
  enroll_tag: "upsurge.probate.ai",
  direction: "outbound",
  retell_agent_id: "retell-1",
  retell_from_number: "+15551234567",
  objective: null,
  crm_provider: null,
  crm_credentials_encrypted: null,
  crm_status: null,
  crm_status_detail: null,
  retell_credentials_encrypted: null,
  status: "active",
  created_at: "",
  updated_at: "",
};

const contact: Contact = {
  id: "contact-1",
  workspace_id: "ws-1",
  crm_contact_id: "123",
  full_name: "Jane Doe",
  email: null,
  phones: ["+15551111111", "+15552222222", "+15553333333"],
  tags: [],
  attempt_count: 2,
  last_called_on: null,
  next_eligible_on: "2026-06-30",
  is_terminal: false,
  terminal_outcome: null,
};

describe("dedupePhones", () => {
  it("preserves order and removes duplicates", () => {
    assert.deepEqual(
      dedupePhones(["+15551111111", "+15552222222", "+15551111111", ""]),
      ["+15551111111", "+15552222222"]
    );
  });
});

describe("dialPhonesForAttempt", () => {
  it("returns all phones for FUB workspaces", () => {
    assert.deepEqual(dialPhonesForAttempt(agent, fubWorkspace, contact), contact.phones);
  });

  it("returns primary phone only for HighLevel workspaces", () => {
    assert.deepEqual(dialPhonesForAttempt(agent, hlWorkspace, contact), ["+15551111111"]);
  });
});

describe("phone sequence decisions", () => {
  it("continues on no_answer_voicemail when more phones remain", () => {
    assert.equal(shouldContinueToNextPhone("no_answer_voicemail", 0, 3), true);
    assert.equal(shouldFinalizeAttempt("no_answer_voicemail", 0, 3), false);
  });

  it("stops and finalizes on appointment", () => {
    assert.equal(shouldStopPhoneSequence("appointment"), true);
    assert.equal(shouldContinueToNextPhone("appointment", 0, 3), false);
    assert.equal(shouldFinalizeAttempt("appointment", 0, 3), true);
  });

  it("stops on answered non-terminal outcomes", () => {
    assert.equal(shouldStopPhoneSequence("follow_up"), true);
    assert.equal(shouldContinueToNextPhone("interested_no_appointment", 1, 3), false);
  });

  it("finalizes after the last phone even on no answer", () => {
    assert.equal(shouldContinueToNextPhone("no_answer_voicemail", 2, 3), false);
    assert.equal(shouldFinalizeAttempt("no_answer_voicemail", 2, 3), true);
  });
});

describe("bullmq job ids", () => {
  it("appends phone index for chained dials", () => {
    assert.equal(bullmqJobIdForPhone("agent:contact:2026-06-30", 0), "agent-contact-2026-06-30");
    assert.equal(bullmqJobIdForPhone("agent:contact:2026-06-30", 2), "agent-contact-2026-06-30-p2");
  });

  it("lists remaining chained job ids", () => {
    assert.deepEqual(
      chainedPhoneJobIds("agent:contact:day", 0, 3),
      ["agent-contact-day-p1", "agent-contact-day-p2"]
    );
  });
});
