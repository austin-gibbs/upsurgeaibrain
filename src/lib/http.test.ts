// =====================================================================
// Unit tests for shared HTTP helpers — the Retry-After parsing that gates
// rate-limit backoff in the CRM adapters.
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { retryAfterMs } from "./http";

describe("retryAfterMs", () => {
  it("parses a seconds value", () => {
    assert.equal(retryAfterMs("2"), 2000);
    assert.equal(retryAfterMs("0"), 0);
  });

  it("clamps to the max", () => {
    assert.equal(retryAfterMs("9999", 2000, 30000), 30000);
  });

  it("falls back to the default when absent or unparseable", () => {
    assert.equal(retryAfterMs(null, 1500), 1500);
    assert.equal(retryAfterMs("not-a-date", 1500), 1500);
  });

  it("parses an HTTP-date in the future as a bounded positive delay", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMs(future, 2000, 30000);
    assert.ok(ms >= 0 && ms <= 30000);
  });

  it("never returns negative for a past HTTP-date", () => {
    const past = new Date(Date.now() - 5000).toUTCString();
    assert.equal(retryAfterMs(past), 0);
  });
});
