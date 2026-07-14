import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAgentContactState,
  defaultAgentContactState,
  type AgentContactState,
} from "./agent-contact-state";
import type { Contact } from "@/types";

const sharedContact: Contact = {
  id: "contact-1",
  workspace_id: "workspace-1",
  crm_contact_id: "97555",
  full_name: "Austin Gibbs",
  email: null,
  phones: ["+15551111111"],
  tags: ["upsurge.probate.ai", "upsurge.ppl.ai"],
  attempt_count: 12,
  last_called_on: "2026-07-01",
  next_eligible_on: "2026-07-21",
  is_terminal: false,
  terminal_outcome: null,
};

describe("applyAgentContactState", () => {
  it("uses fresh state for a newly tagged agent even when the shared contact has old cadence", () => {
    const sellerState = defaultAgentContactState("seller-agent", sharedContact.id);
    const contactForSeller = applyAgentContactState(sharedContact, sellerState);

    assert.equal(contactForSeller.attempt_count, 0);
    assert.equal(contactForSeller.last_called_on, null);
    assert.equal(contactForSeller.next_eligible_on, null);
    assert.equal(contactForSeller.is_terminal, false);
    assert.deepEqual(contactForSeller.tags, sharedContact.tags);
  });

  it("preserves the agent's own cadence when a state row exists", () => {
    const probateState: AgentContactState = {
      agent_id: "probate-agent",
      contact_id: sharedContact.id,
      attempt_count: 12,
      last_called_on: "2026-07-01",
      next_eligible_on: "2026-07-21",
      is_terminal: true,
      terminal_outcome: "dnd",
    };

    const contactForProbate = applyAgentContactState(sharedContact, probateState);

    assert.equal(contactForProbate.attempt_count, 12);
    assert.equal(contactForProbate.next_eligible_on, "2026-07-21");
    assert.equal(contactForProbate.is_terminal, true);
    assert.equal(contactForProbate.terminal_outcome, "dnd");
  });
});
