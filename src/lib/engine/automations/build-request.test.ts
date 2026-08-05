// =====================================================================
// Unit tests for buildRequest() — every post-call automation payload must
// carry recording_url (default, internal_notify, and custom payload_template).
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRequest } from "./build-request";
import type { AutomationEvalContext } from "./types";

const RECORDING = "https://retell.example/rec/abc123.wav";

function ctx(over: Partial<AutomationEvalContext> = {}): AutomationEvalContext {
  return {
    outcome: "follow_up",
    summary: "Caller wants the buyer guide.",
    transcript: "…please text me the buyer guide…",
    recordingUrl: RECORDING,
    customFields: { link_requested: true },
    contact: {
      first_name: "Paul",
      full_name: "Paul Avratin",
      email: "paul@example.com",
      phone: "+14045551234",
    },
    ...over,
  };
}

const link = { type: "buyer_guide", url: "https://ex.com/g.pdf", label: "Buyer's Guide" };

describe("buildRequest — recording_url on every payload", () => {
  it("includes recording_url on the default webhook payload", () => {
    const { payload } = buildRequest(
      {
        name: "Send requested link",
        action_type: "webhook",
        action_config: { url: "https://example.com/hook" },
      },
      ctx(),
      link
    );
    assert.equal(payload.recording_url, RECORDING);
    assert.equal(payload.event, "post_call_automation");
  });

  it("includes recording_url on an internal_notify payload", () => {
    const { payload } = buildRequest(
      {
        name: "Notify ops",
        action_type: "internal_notify",
        action_config: { message_template: "Hit {{outcome}}" },
      },
      ctx(),
      { type: null, url: null, label: null }
    );
    assert.equal(payload.recording_url, RECORDING);
    assert.equal(payload.event, "automation_internal_notify");
  });

  it("force-injects recording_url into a custom payload_template", () => {
    const { payload } = buildRequest(
      {
        name: "Custom",
        action_type: "webhook",
        action_config: {
          url: "https://example.com/hook",
          payload_template: {
            phone: "{{contact.phone}}",
            text: "hi",
          },
        },
      },
      ctx(),
      link
    );
    assert.equal(payload.phone, "+14045551234");
    assert.equal(payload.recording_url, RECORDING);
  });

  it("does not clobber a payload_template that already defines recording_url", () => {
    const { payload } = buildRequest(
      {
        name: "Custom mapped",
        action_type: "webhook",
        action_config: {
          url: "https://example.com/hook",
          payload_template: {
            recording_url: "{{recording_url}}?source=hl",
            phone: "{{contact.phone}}",
          },
        },
      },
      ctx(),
      link
    );
    assert.equal(payload.recording_url, `${RECORDING}?source=hl`);
  });

  it("emits recording_url as null when the call has no recording", () => {
    const { payload } = buildRequest(
      {
        name: "No rec",
        action_type: "webhook",
        action_config: { url: "https://example.com/hook" },
      },
      ctx({ recordingUrl: null }),
      link
    );
    assert.equal(payload.recording_url, null);
    assert.ok("recording_url" in payload);
  });

  it("resolves {{recording_url}} in a message template", () => {
    const { payload } = buildRequest(
      {
        name: "With placeholder",
        action_type: "highlevel_sms",
        action_config: {
          url: "https://example.com/hook",
          message_template: "Listen: {{recording_url}}",
        },
      },
      ctx(),
      link
    );
    assert.equal(payload.message, `Listen: ${RECORDING}`);
  });
});
