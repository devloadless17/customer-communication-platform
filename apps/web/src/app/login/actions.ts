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

  // Do NOT call redirect() here. Better Auth's nextCookies plugin commits
  // the session cookie into the server-action response; redirect() throws
  // NEXT_REDIRECT in the same call which races the cookie commit on Next
  // 15 + useActionState and intermittently produces "An unexpected response
  // was received from the server." Returning the destination lets the
  // client navigate after the action result lands — the cookie is already
  // present on the response so the navigation arrives authenticated.
  return { error: null, redirectTo: safeNext(next) };
}

function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/inbox";
  // "/" is a server component that itself redirects to /inbox. Chaining an
  // action-response redirect into an RSC-render redirect produces "An
  // unexpected response was received from the server" in the Next.js
  // client runtime. Normalize upstream so the navigation lands directly.
  if (next === "/") return "/inbox";
  return next;
}
