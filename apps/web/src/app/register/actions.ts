"use server";

import { redirect } from "next/navigation";

import { signInWithCredentials } from "@/lib/auth";
import { api, ApiError } from "@/lib/api-client";
import { validatePasswordStructure } from "@/lib/auth/password";

/**
 * Org self-signup. Delegates the Team + User + credential Account + stage
 * seed transaction to POST /api/register (NestJS), then signs the user in
 * via Better Auth on the web side to commit the session cookie. The team
 * starts with zero WhatsApp config; the admin is dropped into
 * /settings/whatsapp to connect.
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  if (!EMAIL_RE.test(email)) return fail("Enter a valid email.");

  const policyError = validatePasswordStructure(password);
  if (policyError) return fail(policyError);
  if (password !== confirmPassword) return fail("Passwords do not match.");

  try {
    await api<{ ok: true; email: string; teamId: string }>("/api/register", {
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

  // Server-side redirect — single hop, no chain through `/` or anything
  // else. Better Auth's nextCookies plugin already committed the session
  // cookie to the action response above; redirect() throws NEXT_REDIRECT
  // AFTER that commit so the browser receives cookie + navigation in one
  // round-trip. No intermediate client-side spinner card.
  redirect("/settings/whatsapp");
}
