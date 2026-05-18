"use server";

import { signInWithCredentials } from "@/lib/auth";

export interface LoginState {
  error: string | null;
  /** Destination for the client to navigate to after a successful sign-in. */
  redirectTo?: string;
}

export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/inbox") || "/inbox";

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  // signInWithCredentials wraps Better Auth + the lockout/deactivation gates
  // and returns a result instead of throwing. The session cookie is set by
  // Better Auth's nextCookies plugin during the call — no extra wiring here.
  const result = await signInWithCredentials(email, password);
  if (!result.ok) {
    return { error: result.error ?? "Invalid email or password." };
  }

  // Do NOT call redirect() here. See [hooks/use-auth-redirect.tsx] for the
  // full rationale — TL;DR Better Auth's nextCookies plugin commits the
  // session cookie into the action response; redirect() in the same call
  // throws NEXT_REDIRECT which has historically raced the cookie commit and
  // produced "An unexpected response was received from the server." Return
  // a destination and let the client navigate after the action resolves.
  return { error: null, redirectTo: safeNext(next) };
}

function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/inbox";
  // "/" is an RSC that redirects to /inbox. Chaining an action-response
  // redirect into an RSC-render redirect has produced "An unexpected
  // response was received from the server" in this codebase before —
  // normalize here so the navigation lands directly at /inbox.
  if (next === "/") return "/inbox";
  return next;
}
