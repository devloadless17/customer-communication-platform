import "server-only";

import { headers } from "next/headers";

import { db } from "@/lib/db";
import { auth } from "@/lib/auth/better-auth";
import { clearFailures, isLockedOut, recordFailure } from "@/lib/auth/lockout";

/**
 * Server-side auth surface. Wraps Better Auth so the rest of the app keeps
 * the same call sites (`signInWithCredentials`, `getCurrentSession`) it had
 * with NextAuth. The wrappers also layer the non-framework gates that Better
 * Auth doesn't know about: account-level lockout and the `deactivatedAt`
 * soft-delete.
 *
 * Sign-out is NOT wrapped here — it's a route handler at app/logout/route.ts
 * because pairing Better Auth's cookie mutations with redirect() inside a
 * server action intermittently broke the Next 15 client runtime. Anything
 * that needs to sign a user out should navigate to /logout.
 */

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

  // The two gate checks (lockout + deactivation) both have to land before
  // we spend bcrypt CPU. They share no data, so fire them in parallel.
  // Saves one DB round-trip on every login attempt.
  const [locked, user] = await Promise.all([
    isLockedOut(email),
    db.user.findUnique({
      where: { email },
      select: { id: true, deactivatedAt: true },
    }),
  ]);

  if (locked) {
    // Don't surface "locked out" — return the same message as bad-password
    // so an attacker can't tell whether they tripped the limit or just got
    // a wrong password.
    return { ok: false, error: "Invalid email or password." };
  }

  if (!user) {
    await recordFailure(email);
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
    await recordFailure(email);
    return { ok: false, error: "Invalid email or password." };
  }

  // Fire-and-forget the lockout reset — caller doesn't depend on it landing
  // before the response returns. The cookie's already set; the user is
  // already signed in. A failed delete just leaves a stale (already-passed)
  // counter that the next attempt either resets or overwrites.
  clearFailures(email).catch(() => {});
  return { ok: true };
}

/**
 * Read the current session from cookies. Returns the raw Better Auth
 * payload (`{ session, user }`) or null. Most callers want the higher-level
 * helper in lib/auth/current-user.ts — it layers the deactivation recheck
 * on top so a deactivated user can't keep navigating on a stale cookie.
 */
export async function getCurrentSession() {
  return auth.api.getSession({ headers: await headers() });
}
