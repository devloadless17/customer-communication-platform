/**
 * Phone normalization — the identity key for every WhatsApp contact.
 *
 * This function decides whether an imported customer list can be broadcast to
 * at all. A number it stores wrong is not a visible failure: the import reports
 * success, the contact appears in the directory and in audience counts, and the
 * campaign only fails weeks later, per recipient, at Meta.
 *
 * The three defects pinned here were all found by running real CRM-export
 * shapes through it (2026-07-31), and all three were silent:
 *
 *   - `009613123456` (the international call prefix, which is how half the
 *     world writes a number) kept its `00` and was stored as a distinct,
 *     undeliverable identity that ALSO failed to dedupe against the same
 *     person's inbound wa_id.
 *   - `96171505894.0` — a phone column a spreadsheet read as a NUMBER — had
 *     its trailing zero folded INTO the number, producing a valid-length
 *     number belonging to somebody else. A wrong recipient, not an error.
 *   - `03123456` (national format) had no way to be resolved at all, so an
 *     organization whose CRM stores local numbers could not import at all
 *     without hand-editing the file.
 *
 *   pnpm --filter @ccp/api exec vitest run test/phone-normalization.spec.ts
 */
import { describe, expect, it } from "vitest";

import { normalizePhoneE164 } from "@ccp/shared/utils/phone";

describe("international numbers", () => {
  it("stores digits only, matching Meta's wa_id wire format", () => {
    expect(normalizePhoneE164("+961 3 123 456")).toBe("9613123456");
    expect(normalizePhoneE164("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizePhoneE164("971501234567")).toBe("971501234567");
  });

  it("strips the 00 international call prefix", () => {
    // No country calling code begins with 0, so a leading `00` is
    // unambiguously an IDD prefix — never part of the number.
    expect(normalizePhoneE164("009613123456")).toBe("9613123456");
    expect(normalizePhoneE164("00447911123456")).toBe("447911123456");
    expect(normalizePhoneE164("+00 961 3 123 456")).toBe("9613123456");
  });

  it("dedupes an IDD-written number against the same person's inbound wa_id", () => {
    // The whole point: Meta delivers `9613123456` on inbound. If a CSV row of
    // `009613123456` normalizes differently, the same person exists twice and
    // their reply opens a second thread.
    expect(normalizePhoneE164("009613123456")).toBe(normalizePhoneE164("+9613123456"));
  });
});

describe("spreadsheet artifacts", () => {
  it("does not fold a float's trailing zero into the number", () => {
    // The dangerous one — it produces a WRONG number, not a rejected one.
    expect(normalizePhoneE164("96171505894.0")).toBe("96171505894");
    expect(normalizePhoneE164("+96171505894.00")).toBe("96171505894");
  });

  it("still treats dots as separators in a normal number", () => {
    // The de-float guard must be narrow enough not to touch this.
    expect(normalizePhoneE164("961.71.505.894")).toBe("96171505894");
  });

  it("tolerates the leading apostrophe spreadsheets add to force text", () => {
    expect(normalizePhoneE164("'+96171505894")).toBe("96171505894");
  });
});

describe("national format with a stated country", () => {
  it("resolves a trunk-prefixed local number into a sendable wa_id", () => {
    expect(normalizePhoneE164("03123456", "LB")).toBe("9613123456");
    expect(normalizePhoneE164("07911123456", "GB")).toBe("447911123456");
    expect(normalizePhoneE164("0501234567", "AE")).toBe("971501234567");
  });

  it("accepts a lowercase country code", () => {
    expect(normalizePhoneE164("03123456", "lb")).toBe("9613123456");
  });

  it("lets an international number WIN over the stated country", () => {
    // A file legitimately mixes both. Row-by-row, the number's own country
    // code is the more specific fact and must not be overridden.
    expect(normalizePhoneE164("+15551234567", "LB")).toBe("15551234567");
    expect(normalizePhoneE164("009613123456", "GB")).toBe("9613123456");
  });

  it("ignores an unknown country rather than throwing", () => {
    // Falls through to the lenient path; never crashes an import mid-file.
    expect(normalizePhoneE164("+961 3 123 456", "ZZ")).toBe("9613123456");
  });
});

describe("bounds", () => {
  it("rejects anything outside E.164's 8-15 digits", () => {
    expect(normalizePhoneE164("3123456")).toBeNull(); // 7 digits
    expect(normalizePhoneE164("1234567890123456")).toBeNull(); // 16
    expect(normalizePhoneE164("")).toBeNull();
  });

  it("leaves an unresolvable national number alone rather than guessing", () => {
    // With no country stated there is nothing to resolve it WITH, and inventing
    // one would silently attribute a customer to the wrong country. The import
    // runner rejects this row explicitly instead — a leading zero is never
    // valid in E.164, so it is provably not sendable.
    expect(normalizePhoneE164("03123456")).toBe("03123456");
  });
});
