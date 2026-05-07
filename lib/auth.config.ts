import type { NextAuthConfig } from "next-auth";

import type { Role } from "@/lib/types";

/**
 * Edge-safe NextAuth config. Imported by middleware.ts (Edge runtime), so it
 * MUST NOT import Prisma, bcrypt, or anything Node-only. The full config in
 * lib/auth.ts merges this with the Credentials provider.
 *
 * Why split: Auth.js v5 lets middleware verify the JWT without ever touching
 * the DB; the actual `authorize()` step that bcrypt-checks the password runs
 * in the Node-runtime route handler.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  // No DB session table — JWTs only, signed with AUTH_SECRET.
  session: { strategy: "jwt" },
  callbacks: {
    // Stamp our domain fields onto the token at sign-in, then again on every
    // subsequent request from the token. The session callback projects them
    // onto the session object the app sees.
    async jwt({ token, user }) {
      if (user) {
        // First pass — `user` is the object returned from authorize().
        // user.id is technically optional on Auth.js's User; we never return
        // a user without one, so the `??` keeps tsc happy without runtime cost.
        token.id = user.id ?? token.id;
        token.teamId = (user as { teamId?: string }).teamId ?? token.teamId;
        token.role = (user as { role?: Role }).role ?? token.role;
        token.name = user.name ?? token.name;
        token.email = user.email ?? token.email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.teamId = token.teamId as string;
        session.user.role = token.role as Role;
      }
      return session;
    },
    // Middleware uses this to gate routes. Request is authorized when the
    // token exists; specific role checks happen in the route/page itself.
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
  providers: [], // Filled in by lib/auth.ts (Node runtime).
} satisfies NextAuthConfig;
