import { describe, expect, it } from "vitest";

import { oauthErrorMessage } from "@ccp/shared/auth/oauth-error";

/**
 * What a user reads when "Continue with Google" fails.
 *
 * Before this, Better Auth redirected to its own `/api/auth/error` page, which
 * renders "Something went wrong" over the raw code — the user saw
 *
 *     CODE: account_not_linked
 *
 * on an API route, with no explanation and nothing to click. `onAPIError.errorURL`
 * now points at `/login`, which is where every one of these is recoverable, and
 * this maps the code to a sentence saying what to do.
 */

describe("account_not_linked — the one users actually hit", () => {
  const msg = oauthErrorMessage("account_not_linked")!;

  it("explains the cause without blaming the user", () => {
    // Reached when an account exists for that email but was never verified, so
    // Better Auth refuses to attach the Google identity to it. That refusal is
    // the account-pre-hijacking guard (`requireLocalEmailVerified`, default on),
    // not a malfunction.
    expect(msg).toMatch(/already exists/i);
    expect(msg).toMatch(/verif/i);
  });

  it("names the action that unblocks them", () => {
    // They are standing on the login form; signing in with the password is
    // exactly what resolves it. A message that only describes the problem
    // leaves them stuck on a screen that could have fixed it.
    expect(msg).toMatch(/sign in with your password/i);
  });
});

describe("every other code", () => {
  it("never leaks a raw machine code to the user", () => {
    for (const code of [
      "unable_to_create_user",
      "invalid_code",
      "no_code",
      "unable_to_get_user_info",
      "email_not_found",
      "unable_to_link_account",
      "account_already_linked_to_different_user",
      "some_code_a_future_version_invents",
    ]) {
      const msg = oauthErrorMessage(code);
      expect(msg, code).toBeTruthy();
      // The message must not simply echo the identifier back.
      expect(msg, code).not.toContain(code);
      expect(msg, code).not.toMatch(/_/);
    }
  });

  it("falls back to something actionable for an UNKNOWN code", () => {
    // Better Auth can add codes in a minor release. The default must still tell
    // the user what to do rather than render an empty box.
    const msg = oauthErrorMessage("brand_new_failure_mode")!;
    expect(msg).toMatch(/try again|password/i);
  });
});

describe("no error", () => {
  it("returns null so the page renders nothing at all", () => {
    // `?error=` absent is the normal case for every visit to /login. Returning a
    // generic string here would put a red banner on the login page for everyone.
    expect(oauthErrorMessage(null)).toBeNull();
    expect(oauthErrorMessage(undefined)).toBeNull();
    expect(oauthErrorMessage("")).toBeNull();
  });
});
