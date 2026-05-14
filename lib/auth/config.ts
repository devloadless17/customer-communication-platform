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

const isProd = process.env.NODE_ENV === "production";

/**
 * Sessions persist until the user explicitly signs out — no idle timeout,
 * no short absolute window. 90 days is the hard cap so a stolen device
 * eventually expires; a previous shorter-window setup caused stale-cookie
 * redirect loops after the tab sat idle.
 */
const SESSION_MAX_AGE_S = 90 * 24 * 60 * 60;

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  // JWT sessions only, signed with AUTH_SECRET. Cookie maxAge = JWT exp.
  // updateAge re-issues the token periodically so a long-lived session that
  // keeps getting used pushes its expiry forward.
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_S,
    updateAge: 24 * 60 * 60, // re-sign at most once per day
  },
  // Pin cookie attributes explicitly so the security posture doesn't drift
  // with library defaults. In prod the session cookie uses the __Secure-
  // prefix and CSRF uses __Host- (browser-enforced: must be Secure + Path=/
  // + no Domain).
  cookies: {
    sessionToken: {
      name: isProd ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
    callbackUrl: {
      name: isProd ? "__Secure-authjs.callback-url" : "authjs.callback-url",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
    csrfToken: {
      name: isProd ? "__Host-authjs.csrf-token" : "authjs.csrf-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isProd,
      },
    },
  },
  callbacks: {
    // Stamp domain fields onto the token at sign-in. The JWT's own `exp`
    // (driven by session.maxAge) handles lifetime — no custom expiry logic
    // here. A previous custom-expiry implementation (idle + absolute caps)
    // caused redirect loops when the cookie outlived the in-token deadline.
    async jwt({ token, user }) {
      if (user) {
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
    // session exists; specific role checks happen in the route/page itself.
    authorized({ auth }) {
      return Boolean(auth?.user);
    },
  },
  providers: [], // Filled in by lib/auth.ts (Node runtime).
} satisfies NextAuthConfig;
