import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertUsableMailCredentials,
  mailIsStubbed,
  mailTransport,
  sendMail,
  MailSendError,
} from "@ccp/shared/mail/send";
import { inviteEmail, verificationCodeEmail } from "@ccp/shared/mail/templates";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("sendMail", () => {
  it("does NOT hit the network when unconfigured", async () => {
    // The dev fallback. Without it, every local signup and every e2e run needs
    // a real API key — and the suites would send real mail to invented
    // addresses, which is both wasteful and a fast way to burn a sending
    // reputation.
    delete process.env.BREVO_API_KEY;
    delete process.env.MAIL_FROM;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(mailIsStubbed()).toBe(true);
    await expect(
      sendMail({ to: "a@b.com", subject: "s", html: "<p>h</p>", text: "t" }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs the body when stubbed, so a local signup stays completable", async () => {
    delete process.env.BREVO_API_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sendMail({ to: "a@b.com", subject: "s", html: "<p>h</p>", text: "CODE-123456" });
    // The OTP must be readable from the log — otherwise there is no way to
    // finish a signup without a provider account.
    expect(warn.mock.calls[0]?.[0]).toContain("CODE-123456");
  });

  it("CANNOT reach a provider from a test, even fully configured", async () => {
    // The interlock, and the reason it exists: Brevo's free tier is 300 sends a
    // day and they belong to the customer, not the suite. One unmocked test
    // looping a fixture could spend the lot AND deliver junk to real addresses
    // from a live domain, damaging the sending reputation SPF/DKIM exists to
    // build.
    //
    // Note what this asserts: real credentials are set, `fetch` is NOT mocked
    // away as unusable, and still nothing leaves the process. Relying on every
    // test to remember to mock is a promise that holds until someone forgets.
    process.env.BREVO_API_KEY = "xkeysib-real-looking-key";
    process.env.MAIL_FROM = "noreply@example.com";
    process.env.MAIL_SMTP_HOST = "smtp-relay.brevo.com";
    process.env.MAIL_SMTP_USER = "real@smtp-brevo.com";
    process.env.MAIL_SMTP_PASSWORD = "xsmtpsib-real-looking-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      sendMail({ to: "real@customer.com", subject: "s", html: "h", text: "t" }),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // NOT tested here: that a 400 from Brevo becomes a MailSendError. Exercising
  // that means calling the HTTP path, and the only way to do so under the
  // interlock would be an escape hatch that re-opens the exact hole the
  // interlock closes. The translation is four lines and visible; the quota is
  // not recoverable.
});

describe("templates", () => {
  it("puts the code in the SUBJECT as well as the body", () => {
    // On a phone the notification preview is often enough to type the code
    // without opening anything.
    const m = verificationCodeEmail({ code: "481903", minutes: 10 });
    expect(m.subject).toContain("481903");
    expect(m.text).toContain("481903");
    expect(m.html).toContain("481903");
  });

  it("always ships a text part", () => {
    // A message with no text alternative scores worse with spam filters and is
    // unreadable behind a gateway that strips HTML.
    const invite = inviteEmail({
      url: "https://app.example.com/invite/tok",
      workspaceName: "Acme Support",
      inviterName: "Ali",
    });
    expect(invite.text.length).toBeGreaterThan(0);
    // The raw URL survives in both parts — a button alone dies in any client
    // that strips the anchor, and corporate gateways rewrite links.
    expect(invite.text).toContain("https://app.example.com/invite/tok");
    expect(invite.html).toContain("https://app.example.com/invite/tok");
  });

  it("escapes interpolated names — they are free text", () => {
    const m = inviteEmail({
      url: "https://x.test/i",
      workspaceName: '<img src=x onerror="alert(1)">',
      inviterName: null,
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img");
  });
});

describe("transport selection", () => {
  it("prefers HTTP when both credentials are present", () => {
    // HTTP only needs outbound 443; SMTP needs 587 open and fails as a HANG
    // when it isn't, which is far harder to diagnose than an error.
    process.env.BREVO_API_KEY = "xkeysib-abc";
    process.env.MAIL_SMTP_HOST = "smtp-relay.brevo.com";
    expect(mailTransport()).toBe("http");
  });

  it("falls back to SMTP when only SMTP is configured", () => {
    delete process.env.BREVO_API_KEY;
    process.env.MAIL_SMTP_HOST = "smtp-relay.brevo.com";
    expect(mailTransport()).toBe("smtp");
  });

  it("is stubbed only when NEITHER is configured", () => {
    delete process.env.BREVO_API_KEY;
    delete process.env.MAIL_SMTP_HOST;
    expect(mailTransport()).toBe("stub");
    expect(mailIsStubbed()).toBe(true);
  });

  it("names the mistake when an SMTP key is pasted into BREVO_API_KEY", () => {
    // Asserted against the PURE checker, not through sendMail: the test
    // interlock short-circuits sendMail before any credential is read (by
    // design — see isTestRun), so routing this through it would assert nothing.
    process.env.BREVO_API_KEY = "xsmtpsib-deadbeef";
    expect(() => assertUsableMailCredentials()).toThrow(/xsmtpsib/);
  });

  it("accepts a real HTTP API key", () => {
    process.env.BREVO_API_KEY = "xkeysib-abc123";
    expect(() => assertUsableMailCredentials()).not.toThrow();
  });
});
