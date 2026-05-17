import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { buildSharedAuthOptions } from "@ccp/shared/auth/better-auth-config";

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

export const auth = betterAuth({
  ...buildSharedAuthOptions({
    database: prismaAdapter(db, { provider: "postgresql" }),
    secret: readSecret(),
    baseURL: process.env.BETTER_AUTH_URL,
    isProd,
    passwordHash: (password) => bcrypt.hash(password, 10),
    passwordVerify: ({ password, hash }) => bcrypt.compare(password, hash),
  }),

  // No `nextCookies()` plugin here — the NestJS process only validates
  // existing sessions; it never issues or revokes cookies.
  plugins: [],
});

export type Auth = typeof auth;
export type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;
