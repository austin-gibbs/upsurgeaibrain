// =====================================================================
// Unit tests for Ops default outbound-agent scope selection.
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pickDefaultOpsAgentId } from "./ops-agent-scope";

describe("pickDefaultOpsAgentId", () => {
  const probate = {
    id: "probate",
    status: "active",
    enroll_tag: "upsurge.probate.ai",
  };
  const circle = {
    id: "circle",
    status: "active",
    enroll_tag: "upsurge.circleprospecting.ai",
  };

  it("prefers the agent with the most active queue entries", () => {
    const contacts = [
      { tags: ["upsurge.probate.ai"] },
      { tags: ["upsurge.probate.ai"] },
      { tags: ["upsurge.circleprospecting.ai"] },
    ];
    assert.equal(
      pickDefaultOpsAgentId(
        [probate, circle],
        "upsurge.probate.ai",
        contacts,
        { probate: 0, circle: 100 }
      ),
      "circle"
    );
  });

  it("falls back to most enrolled when queues are empty", () => {
    const contacts = [
      { tags: ["upsurge.probate.ai"] },
      { tags: ["upsurge.circleprospecting.ai"] },
      { tags: ["upsurge.circleprospecting.ai"] },
      { tags: ["upsurge.circleprospecting.ai"] },
    ];
    assert.equal(
      pickDefaultOpsAgentId(
        [probate, circle],
        "upsurge.probate.ai",
        contacts,
        {}
      ),
      "circle"
    );
  });

  it("ignores inactive agents when an active agent exists", () => {
    assert.equal(
      pickDefaultOpsAgentId(
        [
          { ...circle, status: "paused" },
          probate,
        ],
        "upsurge.probate.ai",
        [{ tags: ["upsurge.circleprospecting.ai"] }],
        { circle: 50, probate: 0 }
      ),
      "probate"
    );
  });

  it("returns empty string when there are no outbound agents", () => {
    assert.equal(pickDefaultOpsAgentId([], "tag", [], {}), "");
  });

  it("matches Nil Patel Realty: Circle over Probate when Circle has the queue", () => {
    assert.equal(
      pickDefaultOpsAgentId(
        [
          {
            id: "90a9c10c-77a3-470a-92bf-2eb874448d3f",
            status: "active",
            enroll_tag: "upsurge.probate.ai",
          },
          {
            id: "fafbdf14-5a00-49e2-90ac-bb2064aa5d37",
            status: "active",
            enroll_tag: "upsurge.circleprospecting.ai",
          },
        ],
        "upsurge.probate.ai",
        [
          ...Array.from({ length: 11 }, () => ({
            tags: ["upsurge.probate.ai"],
          })),
          ...Array.from({ length: 100 }, () => ({
            tags: ["upsurge.circleprospecting.ai"],
          })),
        ],
        {
          "90a9c10c-77a3-470a-92bf-2eb874448d3f": 0,
          "fafbdf14-5a00-49e2-90ac-bb2064aa5d37": 100,
        }
      ),
      "fafbdf14-5a00-49e2-90ac-bb2064aa5d37"
    );
  });
});
