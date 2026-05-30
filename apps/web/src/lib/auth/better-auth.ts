// Note: no `server-only` import here — keeping this file framework-neutral so
// nothing accidentally pulls Next-only runtime hooks during a stray import.
// Misuse is guarded structurally: every wrapper that actually needs SSR
// isolation (`signInWithCredentials`, `getCurrentSession`, `getSession`) lives
// in lib/auth/index.ts + lib/auth/current-user.ts and those keep the
// `server-only` import. Client components never reach this file directly.

import bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { buildSharedAuthOptions } from "@ccp/shared/auth/better-auth-config";
import { BCRYPT_COST } from "@ccp/shared/auth/password-policy";

import { db } from "@/lib/db";

/**
 * Better Auth instance for the Next.js side. Source of truth for sessions
 * and credential verification on the cookie-issuing process. Anything
 * outside this file should import the wrappers in `lib/auth/index.ts`
 * (server) or `lib/auth/client.ts` (browser) — keeping direct framework
 * imports here makes a future swap cheaper.
 *
 * The bulk of the config (emailAndPassword, user.additionalFields, session
 * lifetimes, cookie attributes) lives in
 * `packages/shared/src/auth/better-auth-config.ts` and is shared with the
 * NestJS process so both views of "a valid cookie" stay in lockstep. Only
 * the runtime bits (Prisma client, secret, plugin set) differ here.
 *
 * Why DB-backed sessions instead of JWT: every JWT setup eventually creates
 * a state-disagreement bug — middleware sees a still-valid signature, the
 * server component sees a deactivated user, the cookie keeps replaying the
 * same loop. The previous NextAuth setup needed a `?invalid=1` marker just
 * to break out of it. With one row in `Session` as the only truth, that
 * class of bug can't happen.
 */

const isProd = process.env.NODE_ENV === "production";

// Next.js sets NEXT_PHASE=phase-production-build during `next build`. The
// builder evaluates every route module to collect page data, which loads
// this file and constructs the auth instance below. We don't want the build
// to fail just because the build environment doesn't have the production
// secret — runtime env validation in instrumentation.ts (the Next.js boot
// hook that replaced the removed server.ts) is the real gate. So during build,
// fall through to a placeholder; at runtime, throw fast on missing secret.
const IS_BUILD_PHASE = process.env.NEXT_PHASE === "phase-production-build";

function readSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) {
    if (IS_BUILD_PHASE) {
      // Build-time only: the resulting bundle never reads this string;
      // instrumentation.ts validates env on boot and exits if the real secret
      // is missing. Using a deterministic placeholder keeps the build cache
      // hash stable across CI runs.
      return "build-time-placeholder-not-used-at-runtime";
    }
    throw new Error(
      "BETTER_AUTH_SECRET must be set. Generate with: openssl rand -base64 32",
    );
  }
  return s;
}

export const auth = betterAuth({
  ...buildSharedAuthOptions({
    database: prismaAdapter(db, { provider: "postgresql" }),
    secret: readSecret(),
    baseURL: process.env.BETTER_AUTH_URL,
    isProd,
    passwordHash: (password) => bcrypt.hash(password, BCRYPT_COST),
    passwordVerify: ({ password, hash }) => bcrypt.compare(password, hash),
  }),

  // nextCookies() must be the LAST plugin — it converts Better Auth's
  // Set-Cookie responses into Next's cookies() mutations so signin/signout
  // from server actions transparently writes the cookie.
  plugins: [nextCookies()],
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
