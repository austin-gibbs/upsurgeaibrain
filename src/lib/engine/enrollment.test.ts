import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  contactHasEnrollTag,
  isContactEnrolledForAgent,
  resolveEnrollTag,
} from "./enrollment";

describe("resolveEnrollTag", () => {
  it("prefers agent enroll tag over workspace default", () => {
    assert.equal(
      resolveEnrollTag(
        { enroll_tag: "agent.tag" },
        { enroll_tag: "workspace.tag" }
      ),
      "agent.tag"
    );
  });

  it("falls back to workspace enroll tag", () => {
    assert.equal(
      resolveEnrollTag({ enroll_tag: null }, { enroll_tag: "workspace.tag" }),
      "workspace.tag"
    );
  });
});

describe("contactHasEnrollTag", () => {
  it("detects enroll tag on contact", () => {
    assert.equal(
      contactHasEnrollTag({ tags: ["other", "upsurge.probate.ai"] }, "upsurge.probate.ai"),
      true
    );
    assert.equal(
      contactHasEnrollTag({ tags: ["other"] }, "upsurge.probate.ai"),
      false
    );
  });
});

describe("isContactEnrolledForAgent", () => {
  it("returns true when no enroll tag is configured", () => {
    assert.equal(
      isContactEnrolledForAgent(
        { tags: [] },
        { enroll_tag: undefined as unknown as string },
        { enroll_tag: undefined as unknown as string }
      ),
      true
    );
  });

  it("returns false when enroll tag is missing from contact", () => {
    assert.equal(
      isContactEnrolledForAgent(
        { tags: ["Import"] },
        { enroll_tag: null },
        { enroll_tag: "upsurge.probate.ai" }
      ),
      false
    );
  });
});
