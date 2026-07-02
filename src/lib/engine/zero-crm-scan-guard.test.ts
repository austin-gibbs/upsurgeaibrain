import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ZERO_CRM_SCAN_GUARD_THRESHOLD,
  shouldGuardZeroCrmScan,
} from "./zero-crm-scan-guard";

describe("shouldGuardZeroCrmScan", () => {
  it("guards when CRM returns zero but many local contacts remain enrolled", () => {
    assert.equal(
      shouldGuardZeroCrmScan(0, ZERO_CRM_SCAN_GUARD_THRESHOLD),
      true
    );
    assert.equal(shouldGuardZeroCrmScan(0, 500), true);
  });

  it("does not guard when CRM returns contacts", () => {
    assert.equal(shouldGuardZeroCrmScan(12, 500), false);
  });

  it("does not guard for small local enroll counts", () => {
    assert.equal(shouldGuardZeroCrmScan(0, 2), false);
    assert.equal(
      shouldGuardZeroCrmScan(0, ZERO_CRM_SCAN_GUARD_THRESHOLD - 1),
      false
    );
  });
});
