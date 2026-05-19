import bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { buildSharedAuthOptions } from "@ccp/shared/auth/better-auth-config";
import { BCRYPT_COST } from "@ccp/shared/auth/password-policy";

import { db } from "@/lib/db";

/**
 * Better Auth instance for the NestJS side. Only validates existing
 * sessions; never issues or revokes cookies — that's the Next.js process's
 * job via the catch-all in `apps/web/src/app/api/auth/[...all]/route.ts`.
 *
 * The bulk of the config (emailAndPassword, user.additionalFields, session
 * lifetimes, cookie attributes) lives in
 * `packages/shared/src/auth/better-auth-config.ts` and is shared with the
 * Next.js process so both views of "a valid cookie" stay in lockstep.
 *
 * Why DB-backed sessions instead of JWT: every JWT setup eventually creates
 * a state-disagreement bug — middleware sees a still-valid signature, the
 * server component sees a deactivated user, the cookie keeps replaying the
 * same loop. With one row in `Session` as the only truth, that class of
 * bug can't happen.
 */

const isProd = process.env.NODE_ENV === "production";

function readSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set. Generate with: openssl rand -base64 32",
    );
  }
  return s;
}

// Inferred from buildAuth's return value rather than `ReturnType<typeof
// betterAuth>` so the narrow option shape (specifically the `plugins: []`
// tuple type and the inferred `cookieCache` discriminant) propagates
// through without TS rejecting a `Auth<NarrowOpts>` → `Auth<BetterAuthOptions>`
// assignment. The Proxy below preserves the same narrow instance type.
type BetterAuthInstance = ReturnType<typeof buildAuth>;

let _auth: BetterAuthInstance | undefined;

function buildAuth() {
  return betterAuth({
    ...buildSharedAuthOptions({
      database: prismaAdapter(db, { provider: "postgresql" }),
      secret: readSecret(),
      baseURL: process.env.BETTER_AUTH_URL,
      isProd,
      passwordHash: (password) => bcrypt.hash(password, BCRYPT_COST),
      passwordVerify: ({ password, hash }) => bcrypt.compare(password, hash),
    }),

    // No `nextCookies()` plugin here — the NestJS process only validates
    // existing sessions; it never issues or revokes cookies.
    plugins: [],
  });
}

/**
 * Lazy Proxy. The Better Auth singleton — and the `prismaAdapter(db, ...)`
 * call inside it — is constructed on first property access, AFTER
 * NestFactory has booted DbService.onModuleInit (the only place that calls
 * `setSharedDb`). Without this indirection the module-load order between
 * `auth/better-auth.ts` and `db/db.service.ts` is load-bearing: today the
 * Better Auth adapter happens not to read properties of `db` at
 * construction, so the eager call works — but a future Better Auth bump
 * that introspects the Prisma client at adapter construction would crash
 * the api process at boot with the Proxy's "lib/db.ts accessed before
 * DbService booted" error and no compile-time signal that anything broke.
 *
 * The first request that calls `auth.api.getSession(...)` runs after
 * `onModuleInit`, so `setSharedDb` has populated the shared client and
 * the lazy construction sees a real Prisma instance.
 */
export const auth: BetterAuthInstance = new Proxy({} as BetterAuthInstance, {
  get(_target, prop, receiver) {
    if (!_auth) _auth = buildAuth();
    const value = Reflect.get(_auth as object, prop, receiver);
    return typeof value === "function" ? value.bind(_auth) : value;
  },
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
