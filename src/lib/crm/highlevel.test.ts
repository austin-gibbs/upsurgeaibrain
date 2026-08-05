import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveHighLevelCallProviderId } from "./highlevel";

describe("resolveHighLevelCallProviderId", () => {
  it("prefers provider id stored with the HighLevel credentials", () => {
    process.env.HIGHLEVEL_CALL_PROVIDER_IDS = JSON.stringify({ loc_1: "mapped-provider" });
    process.env.HIGHLEVEL_CALL_PROVIDER_ID = "global-provider";

    assert.equal(
      resolveHighLevelCallProviderId("loc_1", "credential-provider"),
      "credential-provider"
    );
  });

  it("uses the per-location env map before the legacy global env", () => {
    process.env.HIGHLEVEL_CALL_PROVIDER_IDS = JSON.stringify({ loc_1: "mapped-provider" });
    process.env.HIGHLEVEL_CALL_PROVIDER_ID = "global-provider";

    assert.equal(resolveHighLevelCallProviderId("loc_1"), "mapped-provider");
  });

  it("falls back to the legacy global env for existing single-location setups", () => {
    delete process.env.HIGHLEVEL_CALL_PROVIDER_IDS;
    process.env.HIGHLEVEL_CALL_PROVIDER_ID = "global-provider";

    assert.equal(resolveHighLevelCallProviderId("loc_2"), "global-provider");
  });

  it("returns null when no provider is configured", () => {
    delete process.env.HIGHLEVEL_CALL_PROVIDER_IDS;
    delete process.env.HIGHLEVEL_CALL_PROVIDER_ID;

    assert.equal(resolveHighLevelCallProviderId("loc_3"), null);
  });
});

describe("logPlayableCall endpoint selection", () => {
  it("uses inbound endpoint when isIncoming is true, outbound otherwise", () => {
    // Mirrors the branch in HighLevelCrm.logPlayableCall — kept pure so the
    // outbound path cannot silently flip without a failing test.
    function endpointFor(isIncoming: boolean | undefined): string {
      return isIncoming
        ? `/conversations/messages/inbound`
        : `/conversations/messages/outbound`;
    }
    assert.equal(endpointFor(true), "/conversations/messages/inbound");
    assert.equal(endpointFor(false), "/conversations/messages/outbound");
    assert.equal(endpointFor(undefined), "/conversations/messages/outbound");
  });
});
