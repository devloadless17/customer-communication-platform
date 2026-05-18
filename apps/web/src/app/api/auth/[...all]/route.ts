import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/better-auth";

// Catch-all for Better Auth's built-in routes (sign-in, sign-out, get-session,
// password endpoints, etc.). Every Better-Auth-managed flow lands here.
//
// Our login/register/invite UI does NOT use these endpoints directly — those
// flows go through server actions in app/login, app/register, app/invite that
// call `auth.api.signInEmail()` so we can layer the lockout + deactivation
// gates on top. The proxy at apps/web/src/proxy.ts hard-blocks POSTs to
// `/api/auth/sign-in/email` and `/api/auth/sign-up/email` for the same reason
// — calling Better Auth directly would skip those gates.
//
// This handler is left mounted so:
//   1. `auth.api.getSession` / sign-out / future password-reset endpoints work
//      without extra routing.
//   2. A future browser-side Better Auth client (`createAuthClient` from
//      better-auth/react) can be added without re-wiring the API surface.
//
// Note: `/api/auth/change-password` is NOT served by this handler — that path
// is owned by the NestJS ChangePasswordController. Caddy routes
// `/api/auth/change-password*` to :4000 *before* this catch-all; the browser
// form at apps/web/src/app/settings/account/change-password-form.tsx targets
// `NEXT_PUBLIC_API_URL` directly in dev (where Caddy isn't in front).

export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);
