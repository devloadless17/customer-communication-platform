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

/** Hard cap for a normal session — no extension regardless of activity. */
const SHORT_SESSION_MS = 8 * 60 * 60 * 1000; // 8 hours
/** Hard cap when the user ticked "Keep me signed in" on the login form. */
const LONG_SESSION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
/** Idle timeout for short sessions: log out after this much inactivity. */
const IDLE_MS = 30 * 60 * 1000; // 30 minutes

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  // No DB session table — JWTs only, signed with AUTH_SECRET.
  //
  // maxAge governs the COOKIE lifetime (max possible). We set it to the long
  // ("remember me") duration so the cookie can survive that long when the
  // user opted in. The actual session-validity check is in the jwt/session
  // callbacks below — they enforce the SHORTER 8h / 30min-idle window for
  // normal sessions by stamping absoluteExp + lastActive into the token.
  //
  // updateAge controls how often the JWT is re-issued (and lastActive
  // updated). 5 min keeps the idle check accurate within ±5 min without
  // re-signing every request.
  session: {
    strategy: "jwt",
    maxAge: LONG_SESSION_MS / 1000,
    updateAge: 5 * 60,
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
    // Stamp our domain fields onto the token at sign-in, then enforce the
    // session-lifetime policy on every subsequent request.
    async jwt({ token, user }) {
      const now = Date.now();

      if (user) {
        // First pass — `user` is the object returned from authorize().
        token.id = user.id ?? token.id;
        token.teamId = (user as { teamId?: string }).teamId ?? token.teamId;
        token.role = (user as { role?: Role }).role ?? token.role;
        token.name = user.name ?? token.name;
        token.email = user.email ?? token.email;

        const remember = (user as { remember?: boolean }).remember === true;
        token.remember = remember;
        token.absoluteExp = now + (remember ? LONG_SESSION_MS : SHORT_SESSION_MS);
        token.lastActive = now;
        return token;
      }

      // Subsequent pass — no `user`, just the persisted token. Legacy tokens
      // (issued before this code shipped) won't have absoluteExp/lastActive;
      // treat them as expired so everyone gets a fresh, short-lived session
      // on the next visit. This is the deploy that signs out the user who
      // was logged in for two days. By design.
      if (typeof token.absoluteExp !== "number" || typeof token.lastActive !== "number") {
        token.expired = true;
        return token;
      }

      const isAbsoluteExpired = now > token.absoluteExp;
      const idleLimit = token.remember ? LONG_SESSION_MS : IDLE_MS;
      const isIdle = now - token.lastActive > idleLimit;

      if (isAbsoluteExpired || isIdle) {
        token.expired = true;
        return token;
      }

      token.lastActive = now;
      return token;
    },
    async session({ session, token }) {
      // Hard expiry — the cookie is still around but the session is dead.
      // Returning null signals "no session" to NextAuth v5; middleware then
      // sees req.auth === null and redirects to /login.
      if (token.expired) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return null as any;
      }
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
