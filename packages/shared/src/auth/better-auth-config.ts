import type { BetterAuthOptions } from "better-auth";

/**
 * Shared Better Auth configuration. Both apps (Next.js + NestJS) need an
 * identical view of `emailAndPassword`, `user.additionalFields`, session
 * lifetimes, and cookie attributes — otherwise the cookie one process
 * issues isn't trusted by the other. Constants + the options builder live
 * here as the single source of truth; each app adds its own `plugins` array
 * (Next.js needs `nextCookies()`; NestJS validates only and needs none).
 *
 * Runtime deps that differ per process (Prisma client, bcrypt) are injected
 * via params so this file stays pure types + plain config.
 */

export const SESSION_MAX_AGE_S = 90 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_S = 24 * 60 * 60;
export const SESSION_COOKIE_CACHE_MAX_AGE_S = 60;
export const COOKIE_PREFIX = "ccp";
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 200;

export interface SharedAuthOptionsParams {
  database: BetterAuthOptions["database"];
  secret: string;
  baseURL?: string;
  isProd: boolean;
  passwordHash: (password: string) => Promise<string>;
  passwordVerify: (input: { password: string; hash: string }) => Promise<boolean>;
}

export function buildSharedAuthOptions(p: SharedAuthOptionsParams): BetterAuthOptions {
  return {
    database: p.database,
    secret: p.secret,
    baseURL: p.baseURL,
    // Better Auth defaults trustedOrigins to [baseURL] when not set — fine in
    // practice, but spelling it out makes the CSRF guard's intent obvious and
    // protects against a future Better Auth default change silently widening
    // the check. lib/env.ts already requires BETTER_AUTH_URL in prod.
    trustedOrigins: p.baseURL ? [p.baseURL] : [],

    emailAndPassword: {
      enabled: true,
      // We do post-signup sign-in explicitly in app/register/actions.ts and
      // app/invite/[token]/actions.ts so the policy + lockout gates stay in
      // one place. Letting Better Auth auto-sign-in would skip the lockout
      // bookkeeping on the immediately-following page load.
      autoSignIn: false,
      // Match the existing local policy — see MIN_PASSWORD_LENGTH in
      // apps/web/src/lib/auth/password.ts. The structure check still runs in
      // our server actions before the call here — this is the second-line
      // defense in case a caller skips it.
      minPasswordLength: MIN_PASSWORD_LENGTH,
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      password: {
        // Reuse bcryptjs so existing User.passwordHash values (now copied
        // into Account.password by the better_auth_tables migration) verify
        // with zero force-resets. Do NOT swap to scrypt without re-hashing
        // every existing row first — Better Auth's default hasher is
        // incompatible.
        hash: p.passwordHash,
        verify: p.passwordVerify,
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
        // 60s cache: balance between session-table DB load and revocation
        // latency. A signOut on the Next.js side deletes the Session row but
        // the cached snapshot here persists for up to 60s — so a signed-out
        // user could keep hitting the API for that window. The earlier 5-min
        // default was too forgiving; 60s is short enough to be visible only
        // under a deliberate stress test.
        //
        // The deactivation gate (loadActiveUser checks User.deactivatedAt)
        // is independent of this cache, so admin-revoked users are blocked
        // immediately regardless.
        enabled: true,
        maxAge: SESSION_COOKIE_CACHE_MAX_AGE_S,
      },
    },

    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: p.isProd,
      defaultCookieAttributes: {
        sameSite: "lax",
        httpOnly: true,
        path: "/",
      },
    },
  };
}
