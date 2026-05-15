import "server-only";

import { headers } from "next/headers";

import { db } from "@/lib/db";
import { auth } from "@/lib/auth/better-auth";
import { clearFailures, isLockedOut, recordFailure } from "@/lib/rate-limit";

/**
 * Server-side auth surface. Wraps Better Auth so the rest of the app keeps
 * the same call sites (`signInWithCredentials`, `signOutCurrentSession`,
 * `getCurrentSession`) it had with NextAuth. The wrappers also layer the
 * non-framework gates that Better Auth doesn't know about: account-level
 * lockout and the `deactivatedAt` soft-delete.
 *
 * Why wrap instead of calling Better Auth directly: keeps every credential
 * check + every signout going through one bookkeeping point. A future swap
 * to magic-link / SSO / SAML lands here, not scattered across actions.
 */

/** Lock an account after this many failed password attempts within the window. */
const LOCKOUT_LIMIT = 5;
/** Lockout window — failed attempts within this duration count toward the limit. */
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export interface SignInResult {
  ok: boolean;
  /** Generic error message safe to surface to the user (no enumeration leaks). */
  error?: string;
}

/**
 * Verify email + password and create a session. Sets the session cookie via
 * Better Auth's nextCookies plugin — no cookie handling required at the
 * call site beyond awaiting this.
 *
 * The order of checks is deliberate:
 *   1. Lockout check (fast, no DB)
 *   2. User lookup → record failure if missing (defeats email enumeration
 *      via the lockout counter — attackers probing unknown emails still
 *      hit the limit)
 *   3. Deactivated check → return generic error WITHOUT recording a failure
 *      (a deactivated user typing their correct password is not an attacker;
 *      we just deny them)
 *   4. Delegate to Better Auth which does bcrypt verify against
 *      Account.password
 *   5. On success: clear failures and stamp the session cookie
 *   6. On failure: record failure and return generic error
 */
export async function signInWithCredentials(
  rawEmail: string,
  password: string,
): Promise<SignInResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) return { ok: false, error: "Invalid email or password." };

  const lockoutKey = `auth:account:${email}`;
  if (isLockedOut(lockoutKey, LOCKOUT_LIMIT)) {
    // Don't surface "locked out" — return the same message as bad-password
    // so an attacker can't tell whether they tripped the limit or just got
    // a wrong password.
    return { ok: false, error: "Invalid email or password." };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, deactivatedAt: true },
  });
  if (!user) {
    recordFailure(lockoutKey, LOCKOUT_WINDOW_MS);
    return { ok: false, error: "Invalid email or password." };
  }

  if (user.deactivatedAt) {
    // Same generic message — don't tell the user (or an enumeration probe)
    // that the account exists but is disabled.
    return { ok: false, error: "Invalid email or password." };
  }

  try {
    await auth.api.signInEmail({
      body: { email, password },
      headers: await headers(),
    });
  } catch {
    // Better Auth throws APIError on bad credentials. Treat any throw as
    // "wrong password" — the framework already returns generic errors so
    // we don't leak which factor failed.
    recordFailure(lockoutKey, LOCKOUT_WINDOW_MS);
    return { ok: false, error: "Invalid email or password." };
  }

  clearFailures(lockoutKey);
  return { ok: true };
}

/**
 * Clear the current session. Server actions that call this should follow
 * with a `redirect()` — Better Auth doesn't redirect on its own, and the
 * sidebar's signout flow needs to close the socket FIRST anyway (see
 * components/inbox/sidebar.tsx).
 */
export async function signOutCurrentSession(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
}

/**
 * Read the current session from cookies. Returns the raw Better Auth
 * payload (`{ session, user }`) or null. Most callers want the higher-level
 * helpers in lib/auth/helpers.ts (API routes) or lib/auth/current-user.ts
 * (server components) — those layer the deactivation recheck on top.
 */
export async function getCurrentSession() {
  return auth.api.getSession({ headers: await headers() });
}
