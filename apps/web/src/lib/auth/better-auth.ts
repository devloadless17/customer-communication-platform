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
import { emailOTP } from "better-auth/plugins";

import {
  buildSharedAuthOptions,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
} from "@ccp/shared/auth/better-auth-config";
import { sendMail } from "@ccp/shared/mail/send";
import { passwordResetCodeEmail, verificationCodeEmail } from "@ccp/shared/mail/templates";
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
    // Google sign-in is enabled by the presence of an OAuth client, nothing
    // else. Absent creds simply drop the provider (and `googleSignInEnabled()`
    // below hides the button) rather than failing the boot.
    google:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }
        : undefined,
  }),

  /**
   * Where a failed OAuth callback lands.
   *
   * Default is Better Auth's own `/api/auth/error`, a bare "Something went
   * wrong / CODE: account_not_linked" page with no way forward — the user is
   * stranded on an API route holding a machine string.
   *
   * `/login` is the right destination because every one of these errors is
   * recoverable from exactly there: the most common by far is
   * `account_not_linked`, which means an account already exists for that email
   * but is not verified, so Better Auth refuses to attach the Google identity
   * to it (that refusal is the account-pre-hijacking guard —
   * `requireLocalEmailVerified`, on by default). Signing in with the password
   * is precisely what unblocks them. The code arrives as `?error=<code>` and
   * `login-form.tsx` turns it into a sentence.
   */
  onAPIError: { errorURL: "/login" },

  databaseHooks: {
    user: {
      create: {
        /**
         * Give a first-time Google user an Organization to belong to.
         *
         * `User.organizationId` is required with no default, so Better Auth's
         * own insert fails without this — "Continue with Google" dead-ends at
         * `unable_to_create_user`.
         *
         * The hook RETURNS THE DATA rather than creating the user itself.
         * Suppressing Better Auth's insert (by returning `false`) was the first
         * attempt and it does not work: `false` aborts the whole sign-in and
         * surfaces as that same `unable_to_create_user`, because a suppressed
         * create is indistinguishable from a failed one. So: create only the
         * ORGANIZATION here, inject its id, and let Better Auth write the row.
         * The Workspace is seeded in the `after` hook below, once a userId
         * exists to own it.
         */
        before: async (user) => {
          const secret = process.env.INTERNAL_BUS_SECRET;
          const base = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";
          if (!secret) {
            throw new Error(
              "INTERNAL_BUS_SECRET missing — cannot provision an organization for a social signup",
            );
          }

          const name = user.name?.trim() || user.email.split("@")[0] || "New";
          const res = await fetch(`${base}/api/internal/provision-oauth-org`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-secret": secret },
            body: JSON.stringify({ name }),
          });
          if (!res.ok) {
            // Throw rather than return false: an explicit failure is reported
            // to the user, whereas a silent abort looks like Google's fault.
            throw new Error(`organization provisioning failed (${res.status})`);
          }
          const { organizationId } = (await res.json()) as { organizationId: string };

          return {
            data: {
              ...user,
              organizationId,
              // The founder OWNS the org — same grant the password signup makes.
              orgRole: "owner",
              // Google asserts a verified email, so there is nothing left for an
              // OTP to prove. Sending one would be theatre costing a send and a
              // step.
              emailVerified: true,
            },
          };
        },
        /**
         * Seed the Workspace now that the founder exists.
         *
         * Stages, #general and the admin membership all need a userId, which is
         * why this cannot happen in `before`. Idempotent server-side, so a
         * retried callback does not seed twice.
         */
        after: async (user) => {
          const secret = process.env.INTERNAL_BUS_SECRET;
          const base = process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4000";
          if (!secret) return;
          const u = user as { id: string; name?: string | null; organizationId?: string };
          if (!u.organizationId) return;

          const res = await fetch(`${base}/api/internal/provision-oauth-workspace`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-internal-secret": secret },
            body: JSON.stringify({
              organizationId: u.organizationId,
              userId: u.id,
              name: u.name?.trim() || "My",
            }),
          });
          if (!res.ok) {
            // The user now has an org but no workspace, which 500s every page.
            // Loud, because it is only repairable by hand.
            console.error(
              `[auth] workspace provisioning failed for user=${u.id}: ${res.status}`,
            );
          }
        },
      },
    },
  },

  plugins: [
    // Email verification by 6-digit code.
    //
    // Lives on the WEB instance only: Better Auth's HTTP routes are served
    // from Next (`/api/auth/*` per the Caddy routing), so this is the process
    // that can actually run the callback. The NestJS instance validates
    // cookies and never issues an OTP.
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_EXPIRY_MINUTES * 60,
      // Burn the code after a handful of wrong guesses. 6 digits is a million
      // combinations, which sounds like plenty until you remember an attacker
      // can try them as fast as the endpoint answers.
      allowedAttempts: OTP_MAX_ATTEMPTS,
      async sendVerificationOTP({ email, otp, type }) {
        // `type` is "email-verification" | "forget-password" | "sign-in".
        // A reset code needs its own copy: unlike a signup code it can arrive
        // unrequested, and it is then the account holder's only warning that
        // someone is trying to take the account — so it must say the password
        // has NOT changed. Same length, expiry and attempt ceiling either way.
        const { subject, html, text } =
          type === "forget-password"
            ? passwordResetCodeEmail({ code: otp, minutes: OTP_EXPIRY_MINUTES })
            : verificationCodeEmail({ code: otp, minutes: OTP_EXPIRY_MINUTES });
        // Deliberately NOT wrapped in a try/catch. A verification email that
        // fails silently leaves someone staring at a code box for a message
        // that is never coming; letting it throw surfaces "we couldn't send
        // it — try again", which is the only honest thing to show.
        await sendMail({ to: email, subject, html, text });
      },
    }),
    // nextCookies() must be the LAST plugin — it converts Better Auth's
    // Set-Cookie responses into Next's cookies() mutations so signin/signout
    // from server actions transparently writes the cookie.
    nextCookies(),
  ],
});

/**
 * Should the UI offer "Continue with Google"?
 *
 * Read from the same env the provider is gated on, so the button can never be
 * shown by a deployment that would then fail the OAuth handshake — the worst
 * version of this feature is a button that dead-ends.
 */
export function googleSignInEnabled(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
