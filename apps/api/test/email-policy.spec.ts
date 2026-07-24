import { describe, expect, it } from "vitest";

import { checkEmailPolicy, isDisposableEmailDomain } from "@ccp/shared/auth/email-policy";

/**
 * Signup accepted anything matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` until
 * 2026-07-23 — which is how "any email works" became literally true. This is the
 * cheap pre-filter; the OTP is the actual proof of ownership.
 */
describe("checkEmailPolicy", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of [
      "ali@loadless.ai",
      "first.last+tag@sub.example.co.uk",
      "a_b-c@example.io",
    ]) {
      expect(checkEmailPolicy(ok), ok).toBeNull();
    }
  });

  it("rejects shapes the old regex let through", () => {
    // `a@b.c` passed the previous check: a one-character TLD is not a domain
    // anyone can receive mail at.
    expect(checkEmailPolicy("a@b.c")).toBe("invalid");
    expect(checkEmailPolicy("no-at-sign.com")).toBe("invalid");
    expect(checkEmailPolicy("two@@example.com")).toBe("invalid");
    expect(checkEmailPolicy("trailing@example.")).toBe("invalid");
    expect(checkEmailPolicy("@example.com")).toBe("invalid");
    expect(checkEmailPolicy("spaces in@example.com")).toBe("invalid");
  });

  it("rejects throwaway-inbox domains", () => {
    expect(checkEmailPolicy("someone@mailinator.com")).toBe("disposable");
    expect(checkEmailPolicy("someone@YOPMAIL.COM")).toBe("disposable");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(checkEmailPolicy("  Ali@Loadless.AI  ")).toBeNull();
  });

  it("does not reject a real domain that merely resembles one", () => {
    // The blocklist is exact-match by design. Substring matching would kill
    // `mail.acme.com` for containing "mail", which is a real customer locked
    // out by a filter that was supposed to stop spam.
    expect(isDisposableEmailDomain("mail.acme.com")).toBe(false);
    expect(isDisposableEmailDomain("tempmail.acme.com")).toBe(false);
    expect(checkEmailPolicy("ops@mail.acme.com")).toBeNull();
  });
});
