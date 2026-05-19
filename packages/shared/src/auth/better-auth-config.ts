import type { BetterAuthOptions } from "better-auth";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy";

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
export const COOKIE_PREFIX = "ccp";

// RFC 6265bis cookie prefixes. Browsers REJECT any Set-Cookie (including
// clears) for these names that doesn't carry `Secure`. Every write/clear
// of an auth cookie must consult `cookieNameRequiresSecure` for its flag.
export const SECURE_COOKIE_NAME_PREFIX = "__Secure-";
export const HOST_COOKIE_NAME_PREFIX = "__Host-";

// Every cookie-name prefix we own. Sign-out enumerates request cookies and
// clears any that match — no hardcoded `session_token` / `session_data`
// list to drift when Better Auth adds a cookie.
export const OWNED_COOKIE_NAME_PREFIXES = [
  `${COOKIE_PREFIX}.`,
  `${SECURE_COOKIE_NAME_PREFIX}${COOKIE_PREFIX}.`,
  `${HOST_COOKIE_NAME_PREFIX}${COOKIE_PREFIX}.`,
] as const;

export function isOwnedCookieName(name: string): boolean {
  for (const p of OWNED_COOKIE_NAME_PREFIXES) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

export function cookieNameRequiresSecure(name: string): boolean {
  return (
    name.startsWith(SECURE_COOKIE_NAME_PREFIX) ||
    name.startsWith(HOST_COOKIE_NAME_PREFIX)
  );
}

// Single rule for "should this process issue cookies with `Secure`."
// Both `app` and `api` run with NODE_ENV=production in prod, so they
// agree. One knob to flip if a `staging` TLS profile is introduced.
export function shouldIssueSecureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

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
      // expiry keeps sliding forward — matches the "no idle logout until
      // 90 days unused" UX. Idle users still hit the 90-day cap.
      updateAge: SESSION_UPDATE_AGE_S,
      // OFF intentionally. The NestJS-side 15s ApiSession cache in
      // `session.guard.ts` is the only cache. BA's 60s cookie cache,
      // when on, created a layering problem: revocations cleared the
      // NestJS cache in 15s but BA kept serving the cached payload for
      // up to 60s. One cache → one TTL → one place to invalidate.
      cookieCache: { enabled: false },
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
