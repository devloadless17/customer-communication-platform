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

/** How long a verification code stays valid. Short enough that a leaked code in
 *  a shared inbox is near-useless, long enough to survive mail-provider delay. */
export const OTP_EXPIRY_MINUTES = 10;
/** Wrong attempts before the code is burned and a new one must be requested. */
export const OTP_MAX_ATTEMPTS = 5;

export interface SharedAuthOptionsParams {
  database: BetterAuthOptions["database"];
  secret: string;
  baseURL?: string;
  isProd: boolean;
  passwordHash: (password: string) => Promise<string>;
  passwordVerify: (input: { password: string; hash: string }) => Promise<boolean>;
  /**
   * Google OAuth credentials, INJECTED rather than read from `process.env`
   * here — this file is deliberately framework- and runtime-neutral (see the
   * header), and reaching for a Node global would break that.
   *
   * Omit to disable Google sign-in. A deployment without an OAuth client should
   * lose the button, not fail to boot.
   */
  google?: { clientId: string; clientSecret: string } | undefined;
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
      // `session.user.workspaceId` directly without a separate DB hit.
      // NOTE: `workspaceId` + `role` used to be mirrored here as
      // additionalFields so the session payload carried tenant scope. Both are
      // gone from the User row: a user belongs to an Organization and joins
      // many workspaces (WorkspaceMember), so there is no single role, and the
      // ACTIVE workspace is resolved per-request from the membership-validated
      // `ccp.ws` cookie. Re-adding them here would reintroduce a stale copy
      // that survives a workspace switch.
      /**
       * Tenant columns Better Auth must be TOLD about before it will write
       * them.
       *
       * Its adapter builds the insert with
       * `for (const field in schema.user.fields)` — a key that is not declared
       * here is dropped from the payload silently, with no warning and no
       * error. The `databaseHooks.user.create.before` hook (see the web auth
       * instance) injects `organizationId` for a first-time Google user, and
       * without these two entries that injection evaporated between the hook
       * and Prisma: `organizationId` is required with no default, so the insert
       * failed as `Argument 'organization' is missing` and every "Continue with
       * Google" dead-ended at `unable_to_create_user`.
       *
       * `orgRole` is here for a quieter version of the same bug: the column
       * defaults to `member`, so a dropped value did not fail the insert — it
       * would just have made the person who CREATED the organization a plain
       * member of it.
       *
       * `input: false` on both: these are server-assigned tenant scope. Left
       * writable, a crafted signup body could name its own `organizationId` and
       * join an arbitrary tenant. Better Auth rejects a client that tries
       * (`parseInputData`), while the database hook — which runs after parsing
       * and merges straight into the adapter call — is unaffected.
       */
      additionalFields: {
        organizationId: { type: "string", required: false, input: false },
        orgRole: { type: "string", required: false, input: false },
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
      // OFF intentionally. The NestJS side runs its own two-tier 15s
      // cache (`sessionCache` keyed by userId + `cookieCache` keyed by
      // hashed cookie → userId — both in `session.guard.ts`, both
      // invalidated together by `invalidateSessionCache(userId)` which
      // walks the cookieCache dropping every entry pointing to the
      // userId). BA's 60s cookie cache, when on, created a layering
      // problem: revocations cleared the NestJS pair in 15s but BA kept
      // serving the cached payload for up to 60s. With BA's cookie
      // cache OFF the NestJS pair becomes the single source of truth —
      // one TTL across both maps, one invalidation path that hits both.
      cookieCache: { enabled: false },
    },

    // Google sign-in.
    //
    // Configured in the SHARED builder so both processes agree on what a valid
    // session looks like, but only ever exercised by the web process (which
    // owns /api/auth/*). Absent credentials disable it rather than crash: a
    // deployment that hasn't set up a Google OAuth client should lose the
    // button, not fail to boot.
    ...(p.google
      ? {
          socialProviders: {
            google: {
              ...p.google,
              // "Continue with Google" must NEVER create an account on its own.
              // Account creation provisions a whole Organization (the create
              // hook), and a returning user who mis-clicks the button on the
              // LOGIN page was silently minting a second org they never asked
              // for. With implicit sign-up off, a Google identity with no
              // existing user is refused BEFORE anything is written, and Better
              // Auth bounces to /login?error=signup_disabled.
              //
              // The signup page opts a creation IN per-request by passing
              // `requestSignUp: true` to signInSocial (see login/google-actions).
              // So: signup page → creates; login page → sign-in only. One flag,
              // enforced by Better Auth's own callback, no intent-guessing in the
              // create hook.
              disableImplicitSignUp: true,
            },
          },
        }
      : {}),

    account: {
      accountLinking: {
        enabled: true,
        // Google asserts a verified email, so linking on a matching address is
        // safe. WITHOUT this, someone who signed up with a password and later
        // clicks "Continue with Google" either gets an opaque error or ends up
        // with a second identity — and since `User.email` is globally unique,
        // the second one cannot even be created. They would simply be locked
        // out of their own account by using the other button.
        trustedProviders: ["google"],
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
