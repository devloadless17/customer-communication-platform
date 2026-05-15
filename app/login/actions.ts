"use server";

import { redirect } from "next/navigation";

import { signIn } from "@/lib/auth";

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

  try {
    // `redirect: false` disables Auth.js's internal redirect/Set-Cookie
    // side-effects. With redirectTo: the failure path emits stray
    // Set-Cookie headers that corrupt the server-action RSC payload —
    // the client sees a generic "unexpected response" instead of our
    // returned error state. redirect:false → signIn either sets the
    // session cookie cleanly (success) or throws (failure). Nothing else.
    await signIn("credentials", {
      email,
      password,
      redirect: false,
    });
  } catch (err) {
    console.error("[login] sign in failed:", err);
    return { error: "Invalid email or password." };
  }

  // Success path: navigate explicitly. redirect() throws NEXT_REDIRECT
  // which Next.js's server-action handler picks up.
  redirect(safeNext(next));
}

function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/inbox";
  return next;
}
