"use server";

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/better-auth";

/**
 * Start the Google handshake.
 *
 * A SERVER ACTION rather than a browser `authClient.signIn.social()` call,
 * because this app has no browser-side Better Auth client and adding one just
 * for a redirect would mean shipping an auth surface to every visitor for a
 * single URL lookup. Better Auth hands back the provider URL; we bounce to it.
 *
 * The redirect target is Better Auth's own `/api/auth/callback/google`, which
 * is the URI registered in the Google Cloud console — `callbackURL` below is
 * where WE want the user afterwards, and Better Auth appends it as state.
 */
export async function startGoogleSignIn(formData: FormData): Promise<void> {
  const raw = String(formData.get("next") ?? "/inbox");
  // Open-redirect guard, same rule the login page applies to `?next=`: only a
  // same-site absolute path. `//evil.com` is a protocol-relative URL and would
  // send the user off-site with a valid session in hand.
  const next =
    raw.startsWith("/") && !raw.startsWith("//") && raw !== "/" ? raw : "/inbox";

  // Only the SIGNUP page may create a new account (and, with it, an
  // Organization). The provider has `disableImplicitSignUp: true`, so a
  // brand-new Google user is refused unless this request explicitly asks to
  // sign up. The login page omits it: a returning user signs in, and a
  // never-seen Google account bounces back as ?error=signup_disabled instead
  // of silently minting an org — the mis-click that started this.
  const isSignup = formData.get("intent") === "signup";

  const result = await auth.api.signInSocial({
    body: {
      provider: "google",
      callbackURL: next,
      ...(isSignup ? { requestSignUp: true } : {}),
    },
  });

  if (!result?.url) {
    // No URL means the provider isn't configured. The button is gated on the
    // same env, so this is close to unreachable — but failing to /login with a
    // marker beats throwing an unhandled error into the action.
    redirect("/login?error=google_unavailable");
  }

  redirect(result.url);
}
