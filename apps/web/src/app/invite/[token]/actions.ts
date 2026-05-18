"use server";

import { cookies } from "next/headers";

import { signInWithCredentials } from "@/lib/auth";
import { api, ApiError } from "@/lib/api-client";
import { validatePasswordStructure } from "@/lib/auth/password";

/**
 * Cookie marker so the auto-revalidated invite page can tell "this browser
 * just accepted" from "stale visitor on a used link" — without depending on
 * getCurrentSession() during revalidation, which sees the *original*
 * request headers (no cookie) and so always reports anonymous.
 */
export const INVITE_JUST_ACCEPTED_COOKIE = "invite-just-accepted";

/**
 * Accept an invite. Delegates the User + Account + invite-accept transaction
 * (and the catalog fan-out) to POST /api/invites/accept; that endpoint lives
 * in NestJS where the event bus runs in-process so the realtime + audit +
 * cache-revalidate subscribers all fire. After the API returns the email,
 * we run Better Auth's signInEmail() on the web side to set the session
 * cookie (Better Auth's nextCookies plugin can't run from NestJS).
 *
 * Why the structural password check still runs here: the API rejects
 * malformed passwords with a 400, but surfacing the error inline is a
 * smoother UX than waiting for the round-trip — we already have the helper.
 */

export interface AcceptState {
  error: string | null;
  /** Destination for the client to navigate to after accepting the invite. */
  redirectTo?: string;
  /** Echoed back on error so the form repopulates non-secret fields. */
  values?: { name?: string };
}

export async function acceptInviteAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  const values = { name };
  const fail = (error: string): AcceptState => ({ error, values });

  if (!token) return fail("Invite token missing.");
  if (!name) return fail("Your name is required.");

  const policyError = validatePasswordStructure(password);
  if (policyError) return fail(policyError);
  if (password !== confirmPassword) return fail("Passwords do not match.");

  let signInEmail: string;
  try {
    const out = await api<{ ok: true; email: string; teamId: string }>(
      "/api/invites/accept",
      { method: "POST", body: { token, name, password }, on401: "throw" },
    );
    signInEmail = out.email;
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string; detail?: string } | undefined;
      if (body?.detail) return fail(body.detail);
      if (body?.error === "email_taken") {
        return fail("An account with this email already exists.");
      }
    }
    console.error("[invite/accept] failed", err);
    return fail("Something went wrong accepting the invite.");
  }

  const signIn = await signInWithCredentials(signInEmail, password);
  if (!signIn.ok) {
    console.error("[invite/accept] post-create sign-in failed:", signIn.error);
    return fail("Account created — please sign in.");
  }

  // Marker for the auto-revalidated render of /invite/[token] that fires
  // right after this action — see INVITE_JUST_ACCEPTED_COOKIE at the top.
  // Same-request cookies().set() IS visible to subsequent cookies().get()
  // in the page render, so this is reliable; the session-cookie check
  // wasn't because headers() reflects the original request only.
  (await cookies()).set(INVITE_JUST_ACCEPTED_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60,
    path: "/",
  });

  // Do NOT call redirect() here — see [hooks/use-auth-redirect.tsx] for
  // the full rationale on why navigation is deferred to the client.
  return { error: null, redirectTo: "/inbox" };
}
