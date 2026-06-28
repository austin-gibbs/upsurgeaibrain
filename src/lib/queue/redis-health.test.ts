import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isRedisQuotaError,
  redisFailureReason,
} from "./redis-health";

describe("isRedisQuotaError", () => {
  it("detects Upstash max requests errors", () => {
    assert.equal(
      isRedisQuotaError(
        new Error(
          "ERR max requests limit exceeded. Limit: 500000, Usage: 500004"
        )
      ),
      true
    );
  });

  it("returns false for unrelated errors", () => {
    assert.equal(isRedisQuotaError(new Error("ECONNREFUSED")), false);
  });
});

describe("redisFailureReason", () => {
  it("maps quota errors", () => {
    assert.equal(
      redisFailureReason(new Error("ERR max requests limit exceeded")),
      "quota_exceeded"
    );
  });

  it("maps connection errors", () => {
    assert.equal(redisFailureReason(new Error("connect ETIMEDOUT")), "connection_failed");
  });
});
