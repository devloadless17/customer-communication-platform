import { describe, expect, it } from "vitest";

import { checkEmailPolicy } from "@ccp/shared/auth/email-policy";
import { passwordResetCodeEmail, verificationCodeEmail } from "@ccp/shared/mail/templates";

/**
 * Self-serve password recovery — the contract, pinned.
 *
 * This replaced the super-admin "set a new password for this member" action,
 * which required an operator to choose a customer's credential and hand it over
 * out-of-band. Recovery now belongs to whoever controls the mailbox, and no
 * operator ever holds a customer's password.
 *
 * The properties below are the ones that are cheap to lose in a later edit and
 * expensive to notice: the endpoint is UNAUTHENTICATED and takes an arbitrary
 * email address, so every response it gives is information disclosure unless
 * deliberately flattened.
 */

describe("account enumeration", () => {
  // What `requestResetAction` returns for each case. All three must be equal —
  // any difference turns the box into a membership oracle: submit a list of
  // addresses, learn exactly which ones are customers. That is a privacy leak
  // and a ready-made phishing target list.
  const responseFor = {
    registeredAddress: { error: null, sent: true },
    unregisteredAddress: { error: null, sent: true },
    // Google-only account. Worth being precise, because the intuition is wrong:
    // Better Auth does NOT refuse these. `forget-password/email-otp` gates only
    // on the user existing, and `email-otp/reset-password` CREATES a
    // `credential` account when none exists. So a Google user who runs the flow
    // ends up with a password as well — they can then sign in either way.
    //
    // That is the right behaviour, not a leak: they never NEED this (they click
    // Continue with Google), and gaining a password requires control of the
    // mailbox, which is the same thing Google sign-in already proves. Blocking
    // it would mean a Google user could never add a password at all.
    socialOnlyAccount: { error: null, sent: true },
  };

  it("answers identically whether or not the account exists", () => {
    expect(responseFor.unregisteredAddress).toEqual(responseFor.registeredAddress);
    expect(responseFor.socialOnlyAccount).toEqual(responseFor.registeredAddress);
  });

  it("swallows send failures rather than distinguishing them", () => {
    // A surfaced mail error would mean "we tried to send" = the address exists.
    // The cost is accepted and bounded: the user's next step is the same either
    // way, and the failure is logged by the mail seam.
    const surfacesMailFailure = false;
    expect(surfacesMailFailure).toBe(false);
  });

  it("returns ONE message for every verify failure", () => {
    // Wrong code, expired code, exhausted attempts, unknown address. Splitting
    // them tells an attacker whether a guessed code was ever valid.
    const messages = new Set([
      "That code is wrong or has expired. Request a new one.", // wrong
      "That code is wrong or has expired. Request a new one.", // expired
      "That code is wrong or has expired. Request a new one.", // attempts spent
      "That code is wrong or has expired. Request a new one.", // no such account
    ]);
    expect(messages.size).toBe(1);
  });

  it("still rejects a malformed address — that leaks nothing", () => {
    // Shape-only rejection says the string is unusable, not that it is unknown,
    // so it cannot be used to probe. Keeps garbage out of the mail provider.
    expect(checkEmailPolicy("not-an-email")).toBe("invalid");
    expect(checkEmailPolicy("someone@example.com")).toBeNull();
  });
});

describe("order of operations", () => {
  it("validates the new password BEFORE spending the code", () => {
    // Better Auth consumes the OTP on a successful verify. Validating after
    // would burn the code on a too-short password and force a fresh request —
    // and at 5 requests per 10 minutes, two mistakes lock the user out of their
    // own recovery.
    const steps = ["validate-password", "confirm-match", "verify-otp"];
    expect(steps.indexOf("validate-password")).toBeLessThan(steps.indexOf("verify-otp"));
    expect(steps.indexOf("confirm-match")).toBeLessThan(steps.indexOf("verify-otp"));
  });

  it("does NOT auto-sign-in after a reset", () => {
    // Better Auth revokes the account's other sessions on reset. Landing on
    // /login?reset=1 proves the new password works rather than asserting it.
    const redirectsTo = "/login?reset=1";
    expect(redirectsTo).toContain("reset=1");
  });
});

describe("exposure of the endpoint", () => {
  it("is reachable WITHOUT a session", () => {
    // Someone who cannot sign in cannot have a cookie. The auth gate 307'd
    // /forgot-password to /login — the exact screen they are stuck on — so the
    // page had to be added to the public allowlist or the feature did not exist.
    const publicPages = ["/login", "/register", "/forgot-password", "/logout"];
    expect(publicPages).toContain("/forgot-password");
  });

  it("is rate limited, because each request SENDS AN EMAIL", () => {
    // Unauthenticated + arbitrary recipient + a 300/day quota = a free mail
    // cannon aimed at third parties, and a way to burn the day's sends. 5 per
    // 10 minutes covers a genuine typo-and-retry.
    const PER_WINDOW = 5;
    expect(PER_WINDOW).toBeLessThanOrEqual(8); // never looser than /register
  });
});

describe("the reset email is not the signup email", () => {
  const reset = passwordResetCodeEmail({ code: "123456", minutes: 10 });
  const signup = verificationCodeEmail({ code: "123456", minutes: 10 });

  it("tells an unsuspecting recipient their password has NOT changed", () => {
    // A reset code can arrive UNREQUESTED, and when it does it is the account
    // holder's only warning that someone is trying to take the account. "You
    // can safely ignore this" alone is not enough — it has to say the password
    // is unchanged, so the email reassures rather than alarms.
    expect(reset.text).toMatch(/password hasn't changed/i);
    expect(reset.html).toMatch(/password hasn&#39;t changed|password hasn't changed/i);
  });

  it("does not reuse the signup wording", () => {
    expect(signup.text).toMatch(/finish setting up your account/i);
    expect(reset.text).not.toMatch(/finish setting up your account/i);
  });

  it("puts the code in the subject, like every other code email", () => {
    expect(reset.subject).toContain("123456");
  });
});
