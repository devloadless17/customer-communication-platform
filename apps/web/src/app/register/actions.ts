"use server";

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
  /** Destination for the client to navigate to after a successful signup. */
  redirectTo?: string;
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

  if (!orgName) return { error: "Organization name is required." };
  if (!name) return { error: "Your name is required." };
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email." };

  const policyError = validatePasswordStructure(password);
  if (policyError) return { error: policyError };

  try {
    await api<{ ok: true; email: string; teamId: string }>("/api/register", {
      method: "POST",
      body: { orgName, name, email, password },
      on401: "throw",
    });
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string; detail?: string } | undefined;
      if (body?.error === "email_taken") return { error: "That email is already in use." };
      if (body?.detail) return { error: body.detail };
    }
    console.error("[register] failed", err);
    return { error: "Something went wrong creating your account." };
  }

  // Sign the user in with the password they just set. Goes through the same
  // wrapper as the login form so the lockout limiter and (vacuous here)
  // deactivation check stay in lockstep across entry points.
  const signIn = await signInWithCredentials(email, password);
  if (!signIn.ok) {
    console.error("[register] post-create sign-in failed:", signIn.error);
    return { error: "Account created — please sign in." };
  }

  // Do NOT call redirect() here. Better Auth's nextCookies plugin commits
  // the session cookie into the server-action response; redirect() throws
  // NEXT_REDIRECT in the same call which races the cookie commit on Next
  // 15 + useActionState. Same root cause as the /login?next=/ bug — return
  // the destination and let the client navigate.
  return { error: null, redirectTo: "/settings/whatsapp" };
}
