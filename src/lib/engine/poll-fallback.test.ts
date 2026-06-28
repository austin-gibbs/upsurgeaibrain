import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Mirror of poll-fallback healthy-path gate (pure logic for tests). */
function shouldRunPollFallback(params: {
  heartbeatStale: boolean;
  redisOk: boolean;
}): boolean {
  return params.heartbeatStale || !params.redisOk;
}

describe("poll-fallback healthy short-circuit", () => {
  it("skips when worker heartbeat is fresh and Redis is ok", () => {
    assert.equal(
      shouldRunPollFallback({ heartbeatStale: false, redisOk: true }),
      false
    );
  });

  it("runs when heartbeat is stale", () => {
    assert.equal(
      shouldRunPollFallback({ heartbeatStale: true, redisOk: true }),
      true
    );
  });

  it("runs when Redis is unhealthy", () => {
    assert.equal(
      shouldRunPollFallback({ heartbeatStale: false, redisOk: false }),
      true
    );
  });
});
