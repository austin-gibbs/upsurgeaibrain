import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDialAttempt } from "./enqueue-dial";
import type { Agent, Contact, Workspace } from "@/types";

const workspace: Workspace = {
  id: "ws-1",
  organization_id: "org-1",
  name: "Nil Patel Realty",
  timezone: "America/New_York",
  crm_provider: "followupboss",
  crm_credentials_encrypted: "enc",
  crm_status: null,
  crm_status_detail: null,
  crm_account_url: null,
  enroll_tag: "upsurge.probate.ai",
  is_active: true,
  created_by: null,
  created_at: "",
  updated_at: "",
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
  phones: ["+15551111111", "+15552222222"],
  tags: [],
  attempt_count: 1,
  last_called_on: null,
  next_eligible_on: "2026-06-30",
  is_terminal: false,
  terminal_outcome: null,
};

describe("buildDialAttempt", () => {
  it("builds a FUB multi-phone job starting at index 0", () => {
    const attempt = buildDialAttempt({
      agent,
      workspace,
      contact,
      agentId: agent.id,
      baseJobId: "agent-1:contact-1:2026-06-30",
      queueDay: "2026-06-30",
      queueEntryId: "queue-1",
    });
    assert.ok(attempt);
    assert.equal(attempt!.attemptNumber, 2);
    assert.deepEqual(attempt!.phoneNumbers, contact.phones);
    assert.equal(attempt!.phoneIndex, 0);
    assert.equal(attempt!.jobData.phoneCount, 2);
    assert.equal(attempt!.jobData.toNumber, "+15551111111");
    assert.equal(attempt!.jobData.queueEntryId, "queue-1");
  });

  it("uses primary phone only for HighLevel workspaces", () => {
    const hlWorkspace = { ...workspace, crm_provider: "highlevel" as const };
    const attempt = buildDialAttempt({
      agent,
      workspace: hlWorkspace,
      contact,
      agentId: agent.id,
      baseJobId: "agent-1:contact-1:2026-06-30",
      queueDay: "2026-06-30",
    });
    assert.ok(attempt);
    assert.deepEqual(attempt!.phoneNumbers, ["+15551111111"]);
    assert.equal(attempt!.jobData.phoneCount, 1);
  });
});
