import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/better-auth";

// Catch-all for Better Auth's built-in routes (sign-in, sign-out, get-session,
// password endpoints, etc.). Every Better-Auth-managed flow lands here.
//
// Our login/register/invite UI does NOT use these endpoints directly — those
// flows go through server actions in app/login, app/register, app/invite that
// call `auth.api.signInEmail()` so we can layer the lockout + deactivation
// gates on top. This handler is here so:
//   1. The browser-side `auth-client` (lib/auth/client.ts) can call signOut.
//   2. Future plugins (password reset, OAuth) work without extra routing.

export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);
