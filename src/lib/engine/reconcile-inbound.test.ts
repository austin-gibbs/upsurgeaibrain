import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Pure diffing logic mirrored from reconcileInboundCalls — kept unit-testable
 * without Retell/Supabase. The live reconciler skips completed + dialing rows
 * and only replays truly missing call ids.
 */
function diffMissingInboundCalls(args: {
  retellIds: string[];
  known: Map<string, string>;
}): { missing: string[]; skippedInProgress: string[] } {
  const missing: string[] = [];
  const skippedInProgress: string[] = [];
  for (const id of args.retellIds) {
    const status = args.known.get(id);
    if (status === "completed") continue;
    if (status === "dialing") {
      skippedInProgress.push(id);
      continue;
    }
    missing.push(id);
  }
  return { missing, skippedInProgress };
}

describe("reconcile inbound diff", () => {
  it("skips already-recorded completed calls", () => {
    const known = new Map([
      ["r1", "completed"],
      ["r2", "completed"],
    ]);
    const result = diffMissingInboundCalls({
      retellIds: ["r1", "r2", "r3"],
      known,
    });
    assert.deepEqual(result.missing, ["r3"]);
    assert.deepEqual(result.skippedInProgress, []);
  });

  it("skips in-progress dialing rows", () => {
    const known = new Map([["r1", "dialing"]]);
    const result = diffMissingInboundCalls({
      retellIds: ["r1", "r2"],
      known,
    });
    assert.deepEqual(result.missing, ["r2"]);
    assert.deepEqual(result.skippedInProgress, ["r1"]);
  });

  it("treats unknown ids as missing", () => {
    const result = diffMissingInboundCalls({
      retellIds: ["a", "b"],
      known: new Map(),
    });
    assert.deepEqual(result.missing, ["a", "b"]);
  });
});
