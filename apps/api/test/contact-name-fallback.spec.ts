import { describe, expect, it } from "vitest";

import { splitContactName } from "@/lib/providers/ingest";

/**
 * `Contact.firstName` must never be an identity fallback.
 *
 * `name` legitimately falls back to the phone number so the inbox list has
 * something to render. `firstName` is different: it is a CLAIM that we know the
 * person's given name, and it is what `$var.contact.first_name` resolves to at
 * send time. Before this guard, a WhatsApp contact created by an OUTBOUND call
 * — where Meta sends no `profile` object at all, because the customer hasn't
 * messaged first — got its phone number written into `firstName`. A broadcast
 * personalised with "Hi {{first_name}}" then greeted people as "Hi 96171505894".
 */
describe("splitContactName", () => {
  it("splits a real display name", () => {
    expect(splitContactName("Ali Al Ahmad")).toEqual({
      firstName: "Ali",
      lastName: "Al Ahmad",
    });
  });

  it("keeps a single-word real name as the first name", () => {
    expect(splitContactName("Ali")).toEqual({ firstName: "Ali", lastName: null });
  });

  it("refuses a bare phone number", () => {
    expect(splitContactName("96171505894")).toEqual({ firstName: null, lastName: null });
    expect(splitContactName("+961 71 505 894")).toEqual({ firstName: null, lastName: null });
  });

  it("refuses opaque provider ids", () => {
    // A webchat visitor key and a WhatsApp BSUID — both are identities we fall
    // back to when there is no name, never names themselves.
    expect(splitContactName("vis_9f2c1a44").firstName).toBeNull();
    expect(splitContactName("LB.946402411360800").firstName).toBeNull();
  });

  it("does NOT reject a real name that contains digits", () => {
    // The guard must stay narrow — "Ali 2" is a name someone actually typed.
    expect(splitContactName("Ali 2")).toEqual({ firstName: "Ali", lastName: "2" });
  });

  it("treats empty / absent as unknown", () => {
    expect(splitContactName(null)).toEqual({ firstName: null, lastName: null });
    expect(splitContactName("   ")).toEqual({ firstName: null, lastName: null });
  });
});
