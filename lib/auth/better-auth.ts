// Note: no `server-only` import here — server.ts pulls this in transitively
// via lib/socket/server.ts (the custom Socket.io handshake calls
// auth.api.getSession). The custom server runs under tsx, outside Next's
// bundler, where "server-only" is unresolvable. Same pattern + rationale as
// lib/socket/server.ts. Misuse is guarded structurally: every wrapper that
// actually needs SSR isolation lives in lib/auth/index.ts, lib/auth/helpers.ts,
// and lib/auth/current-user.ts — those keep the `server-only` import.

import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/lib/db";

/**
 * Better Auth instance. Source of truth for sessions and credential
 * verification. Anything outside this file should import the wrappers in
 * `lib/auth/index.ts` (server) or `lib/auth/client.ts` (browser) — keeping
 * direct framework imports here makes a future swap cheaper.
 *
 * Why DB-backed sessions instead of JWT: every JWT setup eventually creates
 * a state-disagreement bug — middleware sees a still-valid signature, the
 * server component sees a deactivated user, the cookie keeps replaying the
 * same loop. The previous NextAuth setup needed a `?invalid=1` marker just
 * to break out of it. With one row in `Session` as the only truth, that
 * class of bug can't happen.
 *
 * Cost: one DB roundtrip per request that needs auth. Acceptable — every
 * request already does `loadActiveUser()` for the deactivation check.
 */

const isProd = process.env.NODE_ENV === "production";

const SESSION_MAX_AGE_S = 90 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_S = 24 * 60 * 60;

// Next.js sets NEXT_PHASE=phase-production-build during `next build`. The
// builder evaluates every route module to collect page data, which loads
// this file and constructs the auth instance below. We don't want the build
// to fail just because the build environment doesn't have the production
// secret — runtime validation in lib/env.ts (called from server.ts) is the
// real gate. So during build, fall through to a placeholder; at runtime,
// throw fast on missing secret.
const IS_BUILD_PHASE = process.env.NEXT_PHASE === "phase-production-build";

function readSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) {
    if (IS_BUILD_PHASE) {
      // Build-time only: the resulting bundle never reads this string;
      // server.ts validates env on boot and exits if the real secret is
      // missing. Using a deterministic placeholder keeps the build cache
      // hash stable across CI runs.
      return "build-time-placeholder-not-used-at-runtime";
    }
    throw new Error(
      "BETTER_AUTH_SECRET must be set. Generate with: openssl rand -base64 32",
    );
  }
  return s;
}

function readBaseURL(): string | undefined {
  return process.env.BETTER_AUTH_URL;
}

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: "postgresql" }),
  secret: readSecret(),
  baseURL: readBaseURL(),

  emailAndPassword: {
    enabled: true,
    // We do post-signup sign-in explicitly in app/register/actions.ts and
    // app/invite/[token]/actions.ts so the policy + lockout gates stay in
    // one place. Letting Better Auth auto-sign-in would skip the lockout
    // bookkeeping on the immediately-following page load.
    autoSignIn: false,
    // Match the existing local policy (12 chars, see lib/auth/password.ts).
    // The structure check still runs in our server actions before the call
    // here — this is the second-line defense in case a caller skips it.
    minPasswordLength: 12,
    maxPasswordLength: 200,
    password: {
      // Reuse bcryptjs so existing User.passwordHash values (now copied into
      // Account.password by the better_auth_tables migration) verify with
      // zero force-resets. Do NOT swap to scrypt without re-hashing every
      // existing row first — Better Auth's default hasher is incompatible.
      hash: (password) => bcrypt.hash(password, 10),
      verify: ({ password, hash }) => bcrypt.compare(password, hash),
    },
  },

  user: {
    // Surface our domain fields on session.user so handlers can read
    // `session.user.teamId` directly without a separate DB hit.
    additionalFields: {
      teamId: { type: "string", required: true, input: false },
      role: { type: "string", required: true, input: false },
    },
    // Map Better Auth's standard `image` field to our existing avatarUrl
    // column. Lets the framework think it's writing to `image` while the
    // DB keeps its domain-meaningful name.
    fields: {
      image: "avatarUrl",
    },
  },

  session: {
    expiresIn: SESSION_MAX_AGE_S,
    // Re-stamp the session row at most once a day so an active user's
    // expiry keeps sliding forward — matches the previous "no idle logout
    // until 90 days unused" UX. Idle users still hit the 90-day cap.
    updateAge: SESSION_UPDATE_AGE_S,
    cookieCache: {
      // Embed a signed snapshot of the session in the cookie for 5 min so
      // hot paths skip the DB roundtrip. Revocation lag is bounded by this
      // value — acceptable because the deactivation check in
      // lib/auth/active-user.ts hits the DB regardless.
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  advanced: {
    cookiePrefix: "ccp",
    useSecureCookies: isProd,
    defaultCookieAttributes: {
      sameSite: "lax",
      httpOnly: true,
      path: "/",
    },
  },

  // nextCookies() must be the LAST plugin — it converts Better Auth's
  // Set-Cookie responses into Next's cookies() mutations so signin/signout
  // from server actions transparently writes the cookie.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
