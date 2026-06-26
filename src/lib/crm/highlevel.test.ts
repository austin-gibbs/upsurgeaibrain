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
