"use server";

import { redirect } from "next/navigation";

import { signInWithCredentials } from "@/lib/auth";
import { api, ApiError } from "@/lib/api-client";
import { validatePasswordStructure } from "@/lib/auth/password";
import { auth } from "@/lib/auth/better-auth";
import { checkEmailPolicy } from "@ccp/shared/auth/email-policy";

/**
 * Org self-signup. Delegates the Team + User + credential Account + stage
 * seed transaction to POST /api/register (NestJS), then signs the user in
 * via Better Auth on the web side to commit the session cookie. The team is
 * created `pending` (org-approval gate), so the new admin is dropped on
 * /pending — they wait there until a superAdmin approves the org, then land
 * on /settings/whatsapp to connect WhatsApp.
 *
 * Why the transaction lives in NestJS: a dangling Team with no users would
 * orphan the org — worse, an admin User without a Team would 500 on every
 * page load. Better Auth's Account row needs to land in the same
 * transaction as the User so a partial failure leaves nothing behind. The
 * NestJS endpoint runs it all in one $transaction.
 */

export interface RegisterState {
  error: string | null;
  /**
   * Form values echoed back on validation / API error so the form can repopulate.
   * Password fields are intentionally NOT echoed — re-prefilling a password
   * the user typed wrong defeats the confirm-password check.
   */
  values?: {
    orgName?: string;
    name?: string;
    email?: string;
  };
}

export async function registerAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const orgName = String(formData.get("orgName") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const values = { orgName, name, email };
  const fail = (error: string): RegisterState => ({ error, values });

  if (!orgName) return fail("Organization name is required.");
  if (!name) return fail("Your name is required.");
  // Shape + disposable-domain check. The regex this replaced accepted `a@b.c`
  // and every throwaway-inbox service, which is how "any email works" became
  // true. The OTP below is the real proof; this only avoids spending a send on
  // something that was never going to arrive.
  const emailProblem = checkEmailPolicy(email);
  if (emailProblem === "invalid") return fail("Enter a valid email address.");
  if (emailProblem === "disposable") {
    return fail("Please use a permanent work or personal email address.");
  }

  const policyError = validatePasswordStructure(password);
  if (policyError) return fail(policyError);
  if (password !== confirmPassword) return fail("Passwords do not match.");

  try {
    await api<{ ok: true; email: string; workspaceId: string }>("/api/register", {
      method: "POST",
      body: { orgName, name, email, password },
      on401: "throw",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string; detail?: string } | undefined;
      if (body?.error === "email_taken") return fail("That email is already in use.");
      if (body?.detail) return fail(body.detail);
    }
    console.error("[register] failed", err);
    return fail("Something went wrong creating your account.");
  }

  // Sign the user in with the password they just set. Goes through the same
  // wrapper as the login form so the lockout limiter and (vacuous here)
  // deactivation check stay in lockstep across entry points.
  const signIn = await signInWithCredentials(email, password);
  if (!signIn.ok) {
    console.error("[register] post-create sign-in failed:", signIn.error);
    return { error: "Account created — please sign in." };
  }

  // Send the verification code.
  //
  // AFTER sign-in, deliberately: the user now holds a session, so /verify knows
  // who is verifying without putting the email in a query string (which would
  // let anyone request codes for any address by editing the URL).
  //
  // A send failure does NOT fail the signup — the account exists and the code
  // can be re-requested from /verify. Failing here would leave them with an
  // account they cannot reach and no screen explaining why.
  let sendFailed = false;
  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "email-verification" },
    });
  } catch (err) {
    // Carried to /verify so the screen can SAY so. Logging alone left the user
    // staring at a code box for a message that was never coming — and the
    // failure is routinely environmental rather than transient (Brevo answers
    // `525 Unauthorized IP address` when the sending IP isn't allowlisted), so
    // "wait a moment" is the wrong silent default.
    sendFailed = true;
    console.error("[register] verification email failed to send:", err);
  }

  // Server-side redirect — single hop. Better Auth's nextCookies plugin already
  // committed the session cookie to the action response above; redirect() throws
  // NEXT_REDIRECT AFTER that commit so the browser receives cookie + navigation
  // in one round-trip.
  //
  // /verify, not /pending: the org-approval gate matters only once they can act
  // at all, and an unverified session is refused by the API regardless. /verify
  // hands off to /pending once the code is accepted.
  redirect(sendFailed ? "/verify?send=failed" : "/verify");
}
