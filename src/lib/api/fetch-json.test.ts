// =====================================================================
// Unit tests for readJson — defensive parsing so gateway/middleware
// plain-text error pages never surface as "Unexpected token 'A'...".
// Run: npm run test
// =====================================================================
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readJson } from "./fetch-json";

describe("readJson", () => {
  it("parses a valid JSON body", async () => {
    const res = new Response(JSON.stringify({ ok: true, n: 1 }), {
      status: 200,
      statusText: "OK",
    });
    assert.deepEqual(await readJson(res), { ok: true, n: 1 });
  });

  it("returns {} for an empty 200 body", async () => {
    const res = new Response("", { status: 200, statusText: "OK" });
    assert.deepEqual(await readJson(res), {});
  });

  it("throws a readable error for Vercel middleware timeout text", async () => {
    const body =
      "An error occurred with your deployment\n\n504: GATEWAY_TIMEOUT\nCode: MIDDLEWARE_INVOCATION_TIMEOUT";
    const res = new Response(body, {
      status: 504,
      statusText: "Gateway Timeout",
    });
    await assert.rejects(
      () => readJson(res),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Request failed \(504 Gateway Timeout\)/);
        assert.doesNotMatch(err.message, /Unexpected token/);
        return true;
      }
    );
  });

  it("throws a readable error for plain-text 500 bodies", async () => {
    const res = new Response("An error occurred while processing your request", {
      status: 500,
      statusText: "Internal Server Error",
    });
    await assert.rejects(
      () => readJson(res),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Request failed \(500 Internal Server Error\)/);
        assert.doesNotMatch(err.message, /is not valid JSON/);
        return true;
      }
    );
  });

  it("throws on empty non-ok responses", async () => {
    const res = new Response("", { status: 502, statusText: "Bad Gateway" });
    await assert.rejects(
      () => readJson(res),
      /Request failed \(502 Bad Gateway\)/
    );
  });
});
