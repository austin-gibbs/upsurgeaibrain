import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * HighLevel inbound method request-shape tests.
 * We stub global fetch and drive the adapter's private request path indirectly
 * through the public methods.
 */

const LOCATION = "loc_test";
const TOKEN = "tok_test_1234567890";

describe("HighLevel inbound adapter methods", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = mock.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      // Token refresh path shouldn't fire with a far-future expiresAt.
      if (url.includes("/contacts/search")) {
        return new Response(
          JSON.stringify({
            contacts: [
              {
                id: "c1",
                contactName: "Jane Doe",
                phone: "+14045551234",
                tags: ["existing"],
                dateUpdated: "2026-08-01T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/contacts/") && method === "POST") {
        return new Response(
          JSON.stringify({
            contact: {
              id: "c-new",
              firstName: body.firstName,
              lastName: body.lastName,
              phone: body.phone,
              tags: body.tags ?? [],
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/tags") && method === "POST") {
        return new Response(JSON.stringify({ tags: body.tags }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/tags") && method === "DELETE") {
        return new Response(JSON.stringify({ tags: body.tags }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/contacts/") && method === "PUT") {
        return new Response(JSON.stringify({ contact: { id: "c1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    // @ts-expect-error test stub
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function makeAdapter() {
    const { HighLevelAdapter } = await import("./highlevel");
    return new HighLevelAdapter(
      {
        accessToken: TOKEN,
        locationId: LOCATION,
        expiresAt: Date.now() + 60 * 60_000,
      },
      async () => {},
      async () => {}
    );
  }

  it("findContactByPhone posts an OR group on phone + additionalPhones", async () => {
    const adapter = await makeAdapter();
    const contact = await adapter.findContactByPhone("+14045551234");
    assert.ok(contact);
    assert.equal(contact!.id, "c1");

    const searchCall = fetchMock.mock.calls.find((c) =>
      String(c.arguments[0]).includes("/contacts/search")
    );
    assert.ok(searchCall);
    const init = searchCall!.arguments[1] as RequestInit | undefined;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.locationId, LOCATION);
    assert.equal(body.filters[0].group, "OR");
    assert.equal(body.filters[0].filters[0].field, "phone");
    assert.equal(body.filters[0].filters[0].value, "+14045551234");
    assert.equal(body.filters[0].filters[1].field, "additionalPhones");
  });

  it("createContact posts firstName/lastName/phone/tags/source", async () => {
    const adapter = await makeAdapter();
    const created = await adapter.createContact({
      fullName: "Sam Smith",
      phone: "+14045559999",
      tags: ["AI Inbound Call"],
      source: "AI Inbound Call",
    });
    assert.equal(created.id, "c-new");

    const createCall = fetchMock.mock.calls.find((c) => {
      const init = c.arguments[1] as RequestInit | undefined;
      return (
        String(c.arguments[0]).endsWith("/contacts/") &&
        String(init?.method).toUpperCase() === "POST"
      );
    });
    assert.ok(createCall);
    const body = JSON.parse(String((createCall!.arguments[1] as RequestInit).body));
    assert.equal(body.firstName, "Sam");
    assert.equal(body.lastName, "Smith");
    assert.equal(body.phone, "+14045559999");
    assert.deepEqual(body.tags, ["AI Inbound Call"]);
    assert.equal(body.locationId, LOCATION);
  });

  it("addTags and removeTags use additive endpoints", async () => {
    const adapter = await makeAdapter();
    await adapter.addTags("c1", ["tag-a", "tag-b"]);
    await adapter.removeTags("c1", ["tag-old"]);

    const addCall = fetchMock.mock.calls.find((c) => {
      const init = c.arguments[1] as RequestInit | undefined;
      return (
        String(c.arguments[0]).includes("/contacts/c1/tags") &&
        String(init?.method).toUpperCase() === "POST"
      );
    });
    const removeCall = fetchMock.mock.calls.find((c) => {
      const init = c.arguments[1] as RequestInit | undefined;
      return (
        String(c.arguments[0]).includes("/contacts/c1/tags") &&
        String(init?.method).toUpperCase() === "DELETE"
      );
    });
    assert.ok(addCall);
    assert.ok(removeCall);
    assert.deepEqual(
      JSON.parse(String((addCall!.arguments[1] as RequestInit).body)).tags,
      ["tag-a", "tag-b"]
    );
    assert.deepEqual(
      JSON.parse(String((removeCall!.arguments[1] as RequestInit).body)).tags,
      ["tag-old"]
    );
  });
});
