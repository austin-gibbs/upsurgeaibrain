// =====================================================================
// Unit tests for Retell webhook signature verification.
//
// Regression guard for the production 401 bug: Retell signs webhook
// payloads with the account API KEY (Retell.verify(body, apiKey, sig)),
// so the API key must be a valid signing candidate. Before the fix the
// route only tried RETELL_WEBHOOK_SECRET / per-agent webhookSecret, so
// every real webhook failed verification and fell back to reconcile.
// Run: npm run test
// =====================================================================
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { listWebhookSecretCandidates, verifyRetellSignature } from "./client";

/** Build a Retell-format signature: v=<ts>,d=<hmac(body+ts, secret)>. */
function sign(body: string, secret: string, ts = Date.now()): string {
  const digest = createHmac("sha256", secret).update(body + ts).digest("hex");
  return `v=${ts},d=${digest}`;
}

const ORIGINAL_API_KEY = process.env.RETELL_API_KEY;
const ORIGINAL_WEBHOOK_SECRET = process.env.RETELL_WEBHOOK_SECRET;

afterEach(() => {
  process.env.RETELL_API_KEY = ORIGINAL_API_KEY;
  process.env.RETELL_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
});

describe("verifyRetellSignature", () => {
  it("accepts a payload signed with the env RETELL_API_KEY", () => {
    process.env.RETELL_API_KEY = "key_live_apikey";
    delete process.env.RETELL_WEBHOOK_SECRET;
    const body = JSON.stringify({ event: "call_analyzed", call: { call_id: "c1" } });
    const sig = sign(body, "key_live_apikey");
    assert.equal(verifyRetellSignature(body, sig), true);
  });

  it("accepts a payload signed with a per-agent candidate (e.g. its API key)", () => {
    delete process.env.RETELL_API_KEY;
    delete process.env.RETELL_WEBHOOK_SECRET;
    const body = JSON.stringify({ event: "call_ended", call: { call_id: "c2" } });
    const perAgentApiKey = "agent_scoped_key";
    const sig = sign(body, perAgentApiKey);
    assert.equal(verifyRetellSignature(body, sig, [perAgentApiKey]), true);
  });

  it("rejects a payload signed with an unknown secret", () => {
    process.env.RETELL_API_KEY = "key_live_apikey";
    process.env.RETELL_WEBHOOK_SECRET = "whsec_configured";
    const body = JSON.stringify({ event: "call_analyzed", call: { call_id: "c3" } });
    const sig = sign(body, "some_other_secret_retell_never_used");
    assert.equal(verifyRetellSignature(body, sig), false);
  });

  it("rejects when no signature header is present", () => {
    process.env.RETELL_API_KEY = "key_live_apikey";
    const body = JSON.stringify({ event: "call_analyzed" });
    assert.equal(verifyRetellSignature(body, null), false);
  });
});

describe("listWebhookSecretCandidates", () => {
  it("includes the API key and dedupes against the webhook secret", () => {
    process.env.RETELL_API_KEY = "key_live_apikey";
    process.env.RETELL_WEBHOOK_SECRET = "whsec_configured";
    const candidates = listWebhookSecretCandidates(["per_agent_secret", "key_live_apikey"]);
    assert.ok(candidates.includes("key_live_apikey"));
    assert.ok(candidates.includes("whsec_configured"));
    assert.ok(candidates.includes("per_agent_secret"));
    // "key_live_apikey" appears in both extras and env but only once.
    assert.equal(candidates.filter((c) => c === "key_live_apikey").length, 1);
  });
});
