"use server";

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
    await signIn("credentials", {
      email,
      password,
      redirectTo: safeNext(next),
    });
    return { error: null };
  } catch (err) {
    // Success path: signIn throws NEXT_REDIRECT — re-throw so Next can navigate.
    if (isRedirectError(err)) throw err;
    // Anything else (wrong credentials, DB hiccup) → log server-side, show
    // a generic message. We deliberately do not `instanceof AuthError`:
    // bundle/module duplication in production breaks the prototype chain
    // and lets the error leak out as "unexpected response."
    console.error("[login] sign in failed:", err);
    return { error: "Invalid email or password." };
  }
}

function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//")) return "/inbox";
  return next;
}

function isRedirectError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
