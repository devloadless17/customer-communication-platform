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

  // redirect() throws NEXT_REDIRECT which Next.js's server-action handler
  // picks up and turns into a navigation response. Must be outside the
  // result-checking branch — throwing inside the wrapper would be caught.
  redirect(safeNext(next));
}

function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/inbox";
  return next;
}
