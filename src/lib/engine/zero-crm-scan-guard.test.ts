import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LOW_CRM_SCAN_RATIO,
  ZERO_CRM_SCAN_GUARD_THRESHOLD,
  shouldGuardCrmScan,
  shouldGuardSuspiciousLowCrmScan,
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

describe("shouldGuardSuspiciousLowCrmScan", () => {
  it("guards when CRM returns far fewer contacts than local enrolled", () => {
    assert.equal(shouldGuardSuspiciousLowCrmScan(1, 216), true);
    assert.equal(shouldGuardSuspiciousLowCrmScan(12, 500), true);
  });

  it("does not guard when CRM count is a reasonable fraction of local", () => {
    assert.equal(shouldGuardSuspiciousLowCrmScan(100, 110), false);
    assert.equal(
      shouldGuardSuspiciousLowCrmScan(
        Math.ceil(216 * LOW_CRM_SCAN_RATIO),
        216
      ),
      false
    );
  });

  it("does not guard for zero CRM (handled by zero guard)", () => {
    assert.equal(shouldGuardSuspiciousLowCrmScan(0, 500), false);
  });
});

describe("shouldGuardCrmScan", () => {
  it("combines zero and low-scan guards", () => {
    assert.equal(shouldGuardCrmScan(0, 500), true);
    assert.equal(shouldGuardCrmScan(1, 216), true);
    assert.equal(shouldGuardCrmScan(100, 110), false);
    assert.equal(shouldGuardCrmScan(0, 2), false);
  });
});
