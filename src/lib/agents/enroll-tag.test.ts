// =====================================================================
// Unit tests for multi-agent enroll-tag and CRM inheritance helpers.
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  contactHasEnrollTag,
  effectiveEnrollTag,
  enrollTagConflict,
  assertEnrollTagUnique,
  isEnrollTagUniqueViolation,
  suggestDuplicateEnrollTag,
  validateAgentEnrollTagsForWorkspace,
} from "./enroll-tag";
import {
  agentInheritsWorkspaceCrm,
  auditCrmInheritance,
  hasEffectiveCrmCredentials,
} from "./crm-inheritance";
import { validateAgentActivation } from "./activation";

describe("effectiveEnrollTag", () => {
  it("uses agent tag when set", () => {
    assert.equal(effectiveEnrollTag("SellerQueue", "workspace-default"), "sellerqueue");
  });

  it("falls back to workspace tag when agent tag is null", () => {
    assert.equal(effectiveEnrollTag(null, "WorkspaceTag"), "workspacetag");
  });
});

describe("contactHasEnrollTag", () => {
  it("matches case-insensitively", () => {
    assert.equal(
      contactHasEnrollTag(["SellerQueue", "other"], "sellerqueue"),
      true
    );
    assert.equal(contactHasEnrollTag(["other"], "sellerqueue"), false);
  });
});

describe("enrollTagConflict", () => {
  it("detects duplicate effective tags", () => {
    const agents = [
      { id: "a1", direction: "outbound" as const, enroll_tag: "tag-a" },
      { id: "a2", direction: "outbound" as const, enroll_tag: null },
    ];
    assert.equal(enrollTagConflict("tag-a", "workspace", agents), true);
    assert.equal(enrollTagConflict("workspace", "workspace", agents), true);
    assert.equal(
      enrollTagConflict("workspace", "workspace", agents, "a2"),
      false
    );
    assert.equal(
      enrollTagConflict("unique", "workspace", agents),
      false
    );
  });

  it("ignores inbound agents", () => {
    const agents = [
      { id: "a1", direction: "inbound" as const, enroll_tag: "shared" },
    ];
    assert.equal(enrollTagConflict("shared", "workspace", agents), false);
  });
});

describe("validateAgentEnrollTagsForWorkspace", () => {
  it("rejects duplicate tags in provision batch", () => {
    const err = validateAgentEnrollTagsForWorkspace("ws", [
      { direction: "outbound", enroll_tag: "same" },
      { direction: "outbound", enroll_tag: "SAME" },
    ]);
    assert.match(err ?? "", /Duplicate enrollment tag/i);
  });
});

describe("suggestDuplicateEnrollTag", () => {
  it("suggests -copy suffix when base is free", () => {
    const tag = suggestDuplicateEnrollTag("seller", "workspace", []);
    assert.equal(tag, "seller-copy");
  });

  it("increments suffix when -copy is already taken", () => {
    const agents = [
      { id: "a1", direction: "outbound" as const, enroll_tag: "seller-copy" },
    ];
    const tag = suggestDuplicateEnrollTag("seller", "workspace", agents);
    assert.equal(tag, "seller-copy-2");
  });
});

describe("isEnrollTagUniqueViolation", () => {
  it("detects postgres unique violations", () => {
    assert.equal(isEnrollTagUniqueViolation({ code: "23505" }), true);
    assert.equal(isEnrollTagUniqueViolation({ code: "23503" }), false);
    assert.equal(isEnrollTagUniqueViolation(null), false);
  });
});

describe("assertEnrollTagUnique", () => {
  it("returns null when the tag is available", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            returns: async () => ({
              data: [{ id: "a1", direction: "outbound", enroll_tag: "other-tag" }],
            }),
          }),
        }),
      }),
    };
    const result = await assertEnrollTagUnique(
      db as never,
      "workspace-id",
      "new-tag",
      "workspace-default"
    );
    assert.equal(result, null);
  });

  it("returns an error when the tag collides", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            returns: async () => ({
              data: [{ id: "a1", direction: "outbound", enroll_tag: "seller" }],
            }),
          }),
        }),
      }),
    };
    const result = await assertEnrollTagUnique(
      db as never,
      "workspace-id",
      "seller",
      "workspace-default"
    );
    assert.match(result ?? "", /already uses the enrollment tag/i);
  });
});

describe("CRM inheritance", () => {
  const workspace = {
    crm_provider: "highlevel" as const,
    crm_credentials_encrypted: "enc",
  };

  it("inherits when agent has no credentials", () => {
    const agent = { crm_provider: null, crm_credentials_encrypted: null };
    assert.equal(agentInheritsWorkspaceCrm(agent), true);
    assert.equal(hasEffectiveCrmCredentials(agent, workspace), true);
  });

  it("recommends clearing duplicate HighLevel agent creds", () => {
    const audit = auditCrmInheritance(
      {
        id: "agent-1",
        name: "Seller Outgoing",
        crm_provider: "highlevel",
        crm_credentials_encrypted: "agent-enc",
      },
      workspace
    );
    assert.equal(audit.inheritsWorkspaceCrm, false);
    assert.match(audit.recommendation ?? "", /inherit the workspace connection/i);
  });
});

describe("validateAgentActivation", () => {
  const workspaceCrm = {
    crm_provider: "highlevel" as const,
    crm_credentials_encrypted: "enc",
  };

  it("requires explicit enroll tag when multiple outbound agents exist", () => {
    const err = validateAgentActivation({
      agentId: "new",
      direction: "outbound",
      enrollTag: null,
      retellAgentId: "retell",
      retellFromNumber: "+15551234567",
      retellCredentialsEncrypted: null,
      workspaceEnrollTag: "ws-tag",
      existingAgents: [
        { id: "other", direction: "outbound", enroll_tag: "other-tag" },
      ],
      agent: { crm_provider: null, crm_credentials_encrypted: null },
      workspace: workspaceCrm,
      hasCallConfig: true,
    });
    assert.match(err ?? "", /enrollment tag/i);
  });

  it("allows activation when outbound agent has unique tag and inherited CRM", () => {
    const err = validateAgentActivation({
      agentId: "new",
      direction: "outbound",
      enrollTag: "buyer-queue",
      retellAgentId: "retell",
      retellFromNumber: "+15551234567",
      retellCredentialsEncrypted: null,
      workspaceEnrollTag: "ws-tag",
      existingAgents: [
        { id: "other", direction: "outbound", enroll_tag: "seller-queue" },
      ],
      agent: { crm_provider: null, crm_credentials_encrypted: null },
      workspace: workspaceCrm,
      hasCallConfig: true,
    });
    assert.equal(err, null);
  });
});
