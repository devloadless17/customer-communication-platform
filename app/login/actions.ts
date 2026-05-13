"use server";

import { AuthError } from "next-auth";

import { signIn } from "@/lib/auth";

export interface LoginState {
  error: string | null;
}

/**
 * Login server action. Returns a typed error string on failure so the form
 * can render it; on success NextAuth throws a redirect (hence the rethrow).
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/inbox") || "/inbox";
  // Native <input type="checkbox"> only submits when checked, so absence = false.
  const remember = formData.get("remember") != null;

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  try {
    await signIn("credentials", {
      email,
      password,
      // Stringified so it survives the URL-encoded form transport to authorize().
      remember: remember ? "true" : "false",
      redirectTo: safeNext(next),
    });
    return { error: null };
  } catch (err) {
    // NEXT_REDIRECT is how server actions perform navigation — re-throw it.
    if (isRedirectError(err)) throw err;
    if (err instanceof AuthError) {
      return { error: "Invalid email or password." };
    }
    throw err;
  }
}

// Only allow same-origin relative paths as a redirect target. Anything else
// (a full URL, a `//evil.com` protocol-relative) collapses to /inbox.
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
