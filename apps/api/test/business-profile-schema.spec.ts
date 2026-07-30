/**
 * WhatsApp business-profile update rules, straight from Meta's Business Profiles
 * reference. Pure schema validation — no DB, no Graph.
 *
 * Two things this pins, both of which were wrong because the code was written
 * against an older version of that doc:
 *
 *  1. `about` CANNOT be empty. The general rule for this payload is "an absent
 *     field is left alone, an empty string clears it" — but `about` is the one
 *     exception: "String cannot be empty. Strings must be between 1 and 139
 *     characters." We accepted `""` and forwarded it, so an operator trying to
 *     clear their About text got an opaque Meta rejection instead of either
 *     working or being told why.
 *
 *  2. `vertical` IS writable, against Meta's published member list. It was omitted
 *     on the grounds that the `WhatsAppVertical` members "aren't published in the
 *     profile reference" — they are, all 21 of them — so operators had to leave the
 *     product for WhatsApp Manager to set their own business category. Graph
 *     rejects anything unlisted, which is exactly why the enum is the validation.
 *
 *   pnpm --filter @ccp/api exec vitest run test/business-profile-schema.spec.ts
 */
import { describe, expect, it } from "vitest";

import { UpdateBusinessProfileSchema } from "@/workspace-settings/whatsapp/whatsapp.schemas";

const ok = (v: unknown) => UpdateBusinessProfileSchema.safeParse(v).success;

describe("about", () => {
  it("rejects an empty string — Meta does not accept it as a clear", () => {
    expect(ok({ about: "" })).toBe(false);
  });

  it("accepts 1 and 139 characters, rejects 140", () => {
    expect(ok({ about: "a" })).toBe(true);
    expect(ok({ about: "a".repeat(139) })).toBe(true);
    expect(ok({ about: "a".repeat(140) })).toBe(false);
  });
});

describe("vertical", () => {
  it("accepts Meta's published members", () => {
    for (const v of ["RETAIL", "HEALTH", "PROF_SERVICES", "ONLINE_GAMBLING", "OTHER"]) {
      expect(ok({ vertical: v }), v).toBe(true);
    }
  });

  it("accepts an empty string to CLEAR it — the doc allows that explicitly", () => {
    expect(ok({ vertical: "" })).toBe(true);
  });

  it("rejects a plausible-looking value that is not a member", () => {
    // Graph rejects anything unlisted, so guessing here would surface as an opaque
    // Meta error at save time rather than a field-level message.
    expect(ok({ vertical: "RETAILER" })).toBe(false);
    expect(ok({ vertical: "retail" })).toBe(false);
    expect(ok({ vertical: "ECOMMERCE" })).toBe(false);
  });
});

describe("the other documented bounds", () => {
  it("holds address 256, description 512, email 128, websites 2 × 256", () => {
    expect(ok({ address: "a".repeat(256) })).toBe(true);
    expect(ok({ address: "a".repeat(257) })).toBe(false);
    expect(ok({ description: "a".repeat(512) })).toBe(true);
    expect(ok({ description: "a".repeat(513) })).toBe(false);
    expect(ok({ email: `${"a".repeat(50)}@example.com` })).toBe(true);
    expect(ok({ email: "not-an-email" })).toBe(false);
    expect(ok({ websites: ["https://a.com", "https://b.com"] })).toBe(true);
    expect(ok({ websites: ["https://a.com", "https://b.com", "https://c.com"] })).toBe(false);
  });

  it("still lets an empty string CLEAR the fields where that is valid", () => {
    // The general rule the payload documents — `about` is the lone exception.
    expect(ok({ email: "" })).toBe(true);
    expect(ok({ address: "" })).toBe(true);
    expect(ok({ description: "" })).toBe(true);
  });

  it("refuses an empty update outright", () => {
    expect(ok({})).toBe(false);
  });
});
