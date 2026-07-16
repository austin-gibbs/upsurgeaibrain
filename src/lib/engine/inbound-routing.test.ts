import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INBOUND_LINE_ROUTING,
  pickAssigneeForLine,
  resolveLineRep,
  toE164,
} from "./inbound-routing";
import type { CrmUser } from "@/lib/crm/types";

const users: CrmUser[] = [
  { id: "1", name: "Nil Patel" },
  { id: "2", name: "Jori Garcia" },
  { id: "3", name: "Rudi Mauch" },
  { id: "4", name: "Sergio Saballos" },
  { id: "5", name: "Danny Triplin" },
  { id: "6", name: "Someone Else" },
];

describe("toE164", () => {
  it("passes through E.164", () => {
    assert.equal(toE164("+16782571251"), "+16782571251");
  });
  it("adds +1 to a 10-digit number", () => {
    assert.equal(toE164("6782571251"), "+16782571251");
  });
  it("normalizes formatted US numbers", () => {
    assert.equal(toE164("(678) 257-1251"), "+16782571251");
    assert.equal(toE164("1-470-431-4727"), "+14704314727");
  });
  it("returns null for unknown/empty shapes", () => {
    assert.equal(toE164(""), null);
    assert.equal(toE164(null), null);
    assert.equal(toE164("12345"), null);
  });
});

describe("resolveLineRep", () => {
  it("maps each configured line to the right rep", () => {
    assert.equal(resolveLineRep("+16782571251")?.repName, "Nil Patel");
    assert.equal(resolveLineRep("(678) 916-8797")?.repName, "Jori Garcia");
    assert.equal(resolveLineRep("470-431-4727")?.repName, "Rudi Mauch");
    assert.equal(resolveLineRep("4707064491")?.repName, "Sergio Saballos");
    assert.equal(resolveLineRep("+16785626887")?.repName, "Danny Triplin");
  });
  it("returns null for an unmapped number", () => {
    assert.equal(resolveLineRep("+15551234567"), null);
    assert.equal(resolveLineRep(null), null);
  });
});

describe("pickAssigneeForLine", () => {
  it("returns the CRM user owning the dialed line", () => {
    assert.equal(pickAssigneeForLine("+14704314727", users)?.id, "3");
    assert.equal(pickAssigneeForLine("(470) 706-4491", users)?.id, "4");
  });
  it("falls back to first-name match", () => {
    const partial: CrmUser[] = [{ id: "9", name: "Danny T." }];
    assert.equal(pickAssigneeForLine("+16785626887", partial)?.id, "9");
  });
  it("returns null when the line is unmapped", () => {
    assert.equal(pickAssigneeForLine("+15551234567", users), null);
  });
  it("returns null when no CRM user matches the rep", () => {
    assert.equal(
      pickAssigneeForLine("+16782571251", [{ id: "6", name: "Someone Else" }]),
      null
    );
  });
});

describe("INBOUND_LINE_ROUTING", () => {
  it("keys are all valid normalized E.164", () => {
    for (const key of Object.keys(INBOUND_LINE_ROUTING)) {
      assert.equal(toE164(key), key);
    }
  });
});
