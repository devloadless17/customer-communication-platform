/**
 * Turn a Better Auth OAuth callback error code into a sentence a person can act
 * on.
 *
 * Better Auth redirects a failed callback to `<errorURL>?error=<code>` where the
 * code is a machine string (`account_not_linked`, `unable_to_create_user`). We
 * point `errorURL` at `/login` — every one of these is recoverable from there —
 * and this maps the code to copy that says what to DO next. The default
 * behaviour was a bare "Something went wrong / CODE: account_not_linked" page on
 * an API route, which tells the user nothing and offers no way forward.
 *
 * Anything unmapped falls back to a generic sentence rather than leaking the
 * raw code: the codes name internals, and a user who sees `unable_to_get_user_info`
 * learns nothing except that the product is broken.
 */

const MESSAGES: Record<string, string> = {
  /**
   * The one users will actually hit.
   *
   * An account already exists for this email but its address was never
   * verified, so Better Auth refuses to attach the Google identity to it. That
   * refusal is a security control, not a glitch: without it, someone who
   * pre-registers an account at your address would have YOUR Google identity
   * linked into THEIR row — and they still know the password they set. See
   * `requireLocalEmailVerified` (on by default).
   *
   * The fix from the user's side is to sign in with the password and finish
   * verifying, which is exactly what the page they've landed on offers.
   */
  account_not_linked:
    "An account already exists for this email but hasn't been verified yet. Sign in with your password to finish verifying — after that, Continue with Google will work.",

  unable_to_create_user:
    "We couldn't finish creating your account. Try again, or sign up with an email and password instead.",

  // Raised by design when someone clicks "Continue with Google" on the LOGIN
  // page with a Google account that has no user here yet. Account creation is a
  // signup-only act (it provisions an organization), so we refuse rather than
  // silently mint one — the exact mis-click this guards against. The login page
  // already shows a "New here? Create a workspace" link right below, which is
  // where this sentence points them.
  signup_disabled:
    "No account is linked to that Google account yet. Create a workspace first — then Continue with Google will sign you straight in.",

  // The provider rejected or never issued a code — usually a cancelled consent
  // screen or a stale/expired callback.
  invalid_code: "Google sign-in didn't complete. Please try again.",
  no_code: "Google sign-in didn't complete. Please try again.",

  unable_to_get_user_info:
    "Google didn't share your account details. Check the permissions you granted and try again.",

  // The account exists but Google returned no email — nothing to match on.
  email_not_found:
    "Google didn't provide an email address for this account, so we can't sign you in with it. Use your email and password instead.",

  unable_to_link_account:
    "We couldn't connect that Google account. Try again, or sign in with your password.",

  account_already_linked_to_different_user:
    "That Google account is already connected to a different user.",
};

const GENERIC = "Google sign-in didn't complete. Please try again, or sign in with your password.";

/** `null` when there is no error to show, so callers can render nothing. */
export function oauthErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? GENERIC;
}
