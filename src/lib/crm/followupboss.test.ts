import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FollowUpBossAdapter, mapFubCallOutcome } from "./followupboss";

describe("mapFubCallOutcome", () => {
  it("maps follow_up and appointment to Interested", () => {
    assert.equal(mapFubCallOutcome("follow_up", false), "Interested");
    assert.equal(mapFubCallOutcome("appointment", false), "Interested");
  });

  it("maps terminal declines to Not Interested", () => {
    assert.equal(mapFubCallOutcome("not_interested", false), "Not Interested");
    assert.equal(mapFubCallOutcome("dnd", false), "Not Interested");
  });

  it("maps no_answer_voicemail based on voicemail flag", () => {
    assert.equal(mapFubCallOutcome("no_answer_voicemail", true), "Left Message");
    assert.equal(mapFubCallOutcome("no_answer_voicemail", false), "No Answer");
  });

  it("returns undefined for unknown outcomes when not voicemail", () => {
    assert.equal(mapFubCallOutcome("custom_outcome", false), undefined);
    assert.equal(mapFubCallOutcome("custom_outcome", true), "Left Message");
  });
});

describe("FollowUpBossAdapter getContactFieldValues", () => {
  function withFetch(person: unknown, run: (reqs: string[]) => Promise<void>) {
    return async () => {
      const originalFetch = globalThis.fetch;
      const requests: string[] = [];
      globalThis.fetch = (async (url: string | URL | Request) => {
        requests.push(String(url));
        return new Response(JSON.stringify(person), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      try {
        await run(requests);
      } finally {
        globalThis.fetch = originalFetch;
      }
    };
  }

  it(
    "assembles property_address + name from the FUB addresses array",
    withFetch(
      {
        id: 42,
        name: "Jane Homeowner",
        firstName: "Jane",
        lastName: "Homeowner",
        addresses: [
          { type: "home", street: "123 Main St", city: "Austin", state: "TX", code: "78704" },
        ],
      },
      async (requests) => {
        const adapter = new FollowUpBossAdapter({ apiKey: "test-key" });
        const vars = await adapter.getContactFieldValues("42");
        // Requests the addresses field explicitly (FUB omits it by default).
        assert.ok(requests[0].includes("fields="));
        assert.ok(requests[0].includes("addresses"));
        assert.equal(vars.property_address, "123 Main St, Austin, TX 78704");
        assert.equal(vars.first_name, "Jane");
        assert.equal(vars.city, "Austin");
        assert.equal(vars.state, "TX");
        assert.equal(vars.postal_code, "78704");
      }
    )
  );

  it(
    "prefers a home/property-typed address over others",
    withFetch(
      {
        id: 7,
        firstName: "Sam",
        addresses: [
          { type: "work", street: "1 Office Way", city: "Dallas", state: "TX", code: "75001" },
          { type: "property", street: "9 Lakeview Dr", city: "Plano", state: "TX", code: "75024" },
        ],
      },
      async () => {
        const adapter = new FollowUpBossAdapter({ apiKey: "test-key" });
        const vars = await adapter.getContactFieldValues("7");
        assert.equal(vars.property_address, "9 Lakeview Dr, Plano, TX 75024");
      }
    )
  );

  it(
    "omits property_address when the contact has no address (empty, not literal)",
    withFetch(
      { id: 9, firstName: "Pat", addresses: [] },
      async () => {
        const adapter = new FollowUpBossAdapter({ apiKey: "test-key" });
        const vars = await adapter.getContactFieldValues("9");
        assert.equal("property_address" in vars, false);
        assert.equal(vars.first_name, "Pat");
      }
    )
  );
});

describe("FollowUpBossAdapter tag writes", () => {
  it("adds tags using mergeTags instead of replacing the person tag list", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const adapter = new FollowUpBossAdapter({ apiKey: "test-key" });
      await adapter.addTags("123", ["New Tag", "New Tag", "  "]);

      assert.equal(requests.length, 1);
      assert.equal(
        requests[0].url,
        "https://api.followupboss.com/v1/people/123?mergeTags=true"
      );
      assert.equal(requests[0].init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(requests[0].init?.body)), {
        tags: ["New Tag"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
