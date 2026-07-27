"use server";

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/better-auth";
import { validatePasswordStructure } from "@/lib/auth/password";
import { checkEmailPolicy } from "@ccp/shared/auth/email-policy";

/**
 * Self-serve password reset, by emailed 6-digit code.
 *
 * This replaced the super-admin "set a new password for this member" action.
 * That route required an operator to choose a customer's credential and hand it
 * over out-of-band — a person who should never hold it, over a channel with no
 * guarantees. Recovery belongs to whoever controls the mailbox.
 *
 * UNLIKE `/verify`, this screen has no session to resolve the address from, so
 * the email necessarily comes from the form. That makes it an unauthenticated
 * endpoint accepting arbitrary addresses, and the two rules below follow from
 * it directly.
 */

export interface ForgotState {
  error: string | null;
  /** Set once a code has been requested, so the form advances to step 2. */
  sent?: boolean;
  notice?: string | null;
}

/**
 * RULE 1 — never reveal whether an address has an account.
 *
 * The response is identical for a registered address, an unregistered one, and
 * a Google-only account with no password. Anything else turns this box into a
 * membership oracle: an attacker submits a list and learns exactly who is a
 * customer, which is both a privacy leak and a phishing target list.
 */
export async function requestResetAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  // Shape only. A rejection here is about the string being unusable, not about
  // whether it exists — so it still cannot be used to probe for accounts.
  if (checkEmailPolicy(email)) {
    return { error: "Enter a valid email address." };
  }

  try {
    await auth.api.forgetPasswordEmailOTP({ body: { email } });
  } catch {
    // Swallowed on purpose — see RULE 1. This also swallows a genuine mail
    // failure, which is the accepted cost: the alternative distinguishes
    // "couldn't send" (address exists) from "nothing to send" (it doesn't).
    // The user's next step is the same either way, and the send failure is
    // logged by the mail seam.
  }

  return { error: null, sent: true };
}

/**
 * RULE 2 — one message for every failure mode.
 *
 * Wrong code, expired code, too many attempts, and unknown address all return
 * the same string. Distinguishing them tells an attacker whether a guessed code
 * was ever valid, and narrows which addresses are worth attacking.
 */
export async function resetPasswordAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const code = String(formData.get("code") ?? "").replace(/\D/g, "");
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (code.length !== 6) return { error: "Enter the 6-digit code.", sent: true };

  // Password checks run BEFORE the code is spent. Better Auth consumes the OTP
  // on a successful verify, so validating afterwards would burn the code on a
  // too-short password and force the user to request a whole new one.
  const policyError = validatePasswordStructure(password);
  if (policyError) return { error: policyError, sent: true };
  if (password !== confirmPassword) {
    return { error: "Passwords do not match.", sent: true };
  }

  try {
    await auth.api.resetPasswordEmailOTP({ body: { email, otp: code, password } });
  } catch {
    return {
      error: "That code is wrong or has expired. Request a new one.",
      sent: true,
    };
  }

  // Deliberately NOT auto-signed-in. Better Auth revokes the account's other
  // sessions on a password reset (via `revokeSessionsOnPasswordReset` in
  // better-auth-config.ts — the flag is load-bearing, not a default: without
  // it a stolen session survives the reset that exists to kill it), and
  // sending them to /login with the new
  // password fresh in mind is the standard, least-surprising ending — it also
  // proves the reset worked rather than asserting it.
  redirect("/login?reset=1");
}
