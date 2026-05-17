"use server";

import { signInWithCredentials } from "@/lib/auth";
import { api, ApiError } from "@/lib/api-client";
import { validatePasswordStructure } from "@/lib/auth/password";

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
}

export async function acceptInviteAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!token) return { error: "Invite token missing." };
  if (!name) return { error: "Your name is required." };

  const policyError = validatePasswordStructure(password);
  if (policyError) return { error: policyError };

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
      if (body?.detail) return { error: body.detail };
      if (body?.error === "email_taken") {
        return { error: "An account with this email already exists." };
      }
    }
    console.error("[invite/accept] failed", err);
    return { error: "Something went wrong accepting the invite." };
  }

  const signIn = await signInWithCredentials(signInEmail, password);
  if (!signIn.ok) {
    console.error("[invite/accept] post-create sign-in failed:", signIn.error);
    return { error: "Account created — please sign in." };
  }

  // Do NOT call redirect() here — same Better Auth nextCookies + redirect
  // race that broke /login and /register. Hand the destination to the
  // client and let it navigate after the cookie lands.
  return { error: null, redirectTo: "/inbox" };
}
