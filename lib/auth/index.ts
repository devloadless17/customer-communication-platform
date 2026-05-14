import "server-only";

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { clearFailures, isLockedOut, recordFailure } from "@/lib/rate-limit";

import { authConfig } from "./config";

/**
 * Full NextAuth config — Node runtime only. Adds the Credentials provider that
 * looks up the user by email and bcrypt-verifies the password.
 *
 * Anything outside middleware imports `auth`/`signIn`/`signOut` from here.
 * The shared edge-safe pieces (callbacks, pages, session strategy) live in
 * lib/auth/config.ts.
 */

/** Lock an account after this many failed password attempts within the window. */
const LOCKOUT_LIMIT = 5;
/** Lockout window — failed attempts within this duration count toward the limit. */
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const email = typeof raw?.email === "string" ? raw.email.trim().toLowerCase() : "";
        const password = typeof raw?.password === "string" ? raw.password : "";
        if (!email || !password) return null;

        // Account-level lockout. The middleware's IP limit catches one attacker
        // hammering one IP; this catches a distributed attack hammering one
        // account from many IPs. Keyed by email so the limiter is per-account.
        const lockoutKey = `auth:account:${email}`;
        if (isLockedOut(lockoutKey, LOCKOUT_LIMIT)) {
          // Return null so NextAuth surfaces the same "Invalid email or
          // password" message — don't leak that the account is locked.
          return null;
        }

        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) {
          // Count as a failure so attackers probing unknown emails still hit
          // the limit. Without this, the lockout only protects accounts that
          // actually exist — which lets the attacker enumerate emails by
          // observing which ones eventually lock.
          recordFailure(lockoutKey, LOCKOUT_WINDOW_MS);
          return null;
        }
        // Block sign-in for soft-disabled users — admins deactivate without
        // deleting so message attribution survives. Don't count as a failure;
        // it's not a credential issue.
        if (user.deactivatedAt) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) {
          recordFailure(lockoutKey, LOCKOUT_WINDOW_MS);
          return null;
        }

        clearFailures(lockoutKey);

        return {
          id: user.id,
          teamId: user.teamId,
          role: user.role,
          name: user.name,
          email: user.email,
          image: user.avatarUrl ?? null,
        };
      },
    }),
  ],
});
