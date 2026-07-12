import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describeSchedulerMode,
  shouldRunInternalScheduler,
} from "./worker-scheduler";

describe("shouldRunInternalScheduler", () => {
  it("runs by default when env is empty", () => {
    assert.equal(shouldRunInternalScheduler({}), true);
  });

  it("still runs when legacy USE_EXTERNAL_CRON=true", () => {
    assert.equal(
      shouldRunInternalScheduler({ USE_EXTERNAL_CRON: "true" }),
      true
    );
  });

  it("opts out only for DISABLE_INTERNAL_SCHEDULER truthy values", () => {
    assert.equal(
      shouldRunInternalScheduler({ DISABLE_INTERNAL_SCHEDULER: "true" }),
      false
    );
    assert.equal(
      shouldRunInternalScheduler({ DISABLE_INTERNAL_SCHEDULER: "1" }),
      false
    );
    assert.equal(
      shouldRunInternalScheduler({ DISABLE_INTERNAL_SCHEDULER: "yes" }),
      false
    );
    assert.equal(
      shouldRunInternalScheduler({ DISABLE_INTERNAL_SCHEDULER: "false" }),
      true
    );
  });
});

describe("describeSchedulerMode", () => {
  it("mentions internal loop by default", () => {
    assert.match(describeSchedulerMode({}), /internal 30s/);
  });

  it("mentions disable flag when opted out", () => {
    assert.match(
      describeSchedulerMode({ DISABLE_INTERNAL_SCHEDULER: "true" }),
      /DISABLE_INTERNAL_SCHEDULER/
    );
  });
});
