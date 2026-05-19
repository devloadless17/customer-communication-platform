"use server";

import { redirect } from "next/navigation";

import { signInWithCredentials } from "@/lib/auth";

export interface LoginState {
  error: string | null;
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

  // Server-side redirect. The cookie has already been committed to the
  // action response by Better Auth's nextCookies plugin; redirect() throws
  // NEXT_REDIRECT AFTER that commit so the browser receives both the
  // cookie AND the navigation in the same response.
  //
  // Earlier this used a `{ redirectTo }` return + client-side router.replace
  // because a CHAIN through `/` (action → `/` RSC → re-redirect to /inbox)
  // produced "An unexpected response was received from the server." The
  // `safeNext` normalization below collapses `/` to `/inbox` directly, so
  // there is no chain — one hop, no race. Calling redirect() here removes
  // the post-action spinner the user perceived as "the form flashing."
  redirect(safeNext(next));
}

function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/inbox";
  // "/" is an RSC that redirects to /inbox. Chaining the action's redirect
  // into the RSC's redirect causes the legacy "unexpected response" bug —
  // normalize here so the redirect lands directly at /inbox.
  if (next === "/") return "/inbox";
  return next;
}
