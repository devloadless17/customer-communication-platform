import "server-only";

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";

import { authConfig } from "./auth.config";

/**
 * Full NextAuth config — Node runtime only. Adds the Credentials provider that
 * looks up the user by email and bcrypt-verifies the password.
 *
 * Anything outside middleware imports `auth`/`signIn`/`signOut` from here.
 * The shared edge-safe pieces (callbacks, pages, session strategy) live in
 * lib/auth.config.ts.
 */
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

        const user = await db.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) return null;
        // Block sign-in for soft-disabled users — admins deactivate without
        // deleting so message attribution survives.
        if (user.deactivatedAt) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

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
