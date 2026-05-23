import "server-only";

import { db } from "@/lib/db";

/**
 * Account-level lockout, persisted in Postgres.
 *
 * Replaces the in-process Map version that lived in `lib/rate-limit.ts`.
 * Persistence matters: a process restart (deploy, OOM, systemd
 * Restart=on-failure) used to clear lockout history, which combined with
 * the lowered password floor left a real brute-force window. The
 * LoginAttempt table makes lockouts survive across restarts.
 *
 * Window semantics: after `LOCKOUT_THRESHOLD` consecutive failures,
 * `lockedUntil` is set to `now + LOCKOUT_DURATION_MS`. The gate refuses
 * while `lockedUntil > now()` without consulting the counter, so a correct
 * password during the lock window still bounces.
 *
 * The counter resets on (a) a successful sign-in or (b) any failure after
 * `lockedUntil` has passed — at that point the row is rewritten with
 * `failedCount: 1` and a cleared `lockedUntil`. This is a sliding-reset:
 * a single late guess after the lockout expires doesn't count as "5 in a
 * row" against the original spree.
 */

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Returns true if the account is currently locked out. Fast — single
 * indexed read by email. Safe to call on every login attempt.
 */
export async function isLockedOut(email: string): Promise<boolean> {
  const attempt = await db.loginAttempt.findUnique({
    where: { email },
    select: { lockedUntil: true },
  });
  if (!attempt?.lockedUntil) return false;
  return attempt.lockedUntil > new Date();
}

/**
 * Record a failed login attempt. The counter bump is a TRUE atomic increment
 * (`{ increment: 1 }`), NOT a read-then-write — concurrent failures for the
 * same email (a parallel guessing burst) each count instead of collapsing N
 * attempts into one increment, which would otherwise inflate the effective
 * brute-force budget to ~batch-size guesses per increment. We read back the
 * post-increment count and stamp `lockedUntil` once it crosses the threshold.
 */
export async function recordFailure(email: string): Promise<void> {
  const now = new Date();
  const existing = await db.loginAttempt.findUnique({
    where: { email },
    select: { lockedUntil: true },
  });

  // Past-lockout failure: treat as the start of a new spree rather than
  // a continuation. Replaces the row so a stale `lockedUntil` from days
  // ago doesn't influence the new count.
  if (existing?.lockedUntil && existing.lockedUntil <= now) {
    await db.loginAttempt.update({
      where: { email },
      data: { failedCount: 1, lockedUntil: null, lastFailedAt: now },
    });
    return;
  }

  // Atomic increment — the DB does the add, so two concurrent failures both
  // land (counter goes to N, not 1). create-path starts at 1.
  const row = await db.loginAttempt.upsert({
    where: { email },
    create: { email, failedCount: 1, lastFailedAt: now },
    update: { failedCount: { increment: 1 }, lastFailedAt: now },
    select: { failedCount: true, lockedUntil: true },
  });

  // Stamp the lock once the post-increment count crosses the threshold. The
  // `!row.lockedUntil` guard makes this a one-shot per spree; once locked,
  // signInWithCredentials short-circuits on isLockedOut() before reaching
  // recordFailure again, so the lock window is fixed from the crossing attempt.
  if (row.failedCount >= LOCKOUT_THRESHOLD && !row.lockedUntil) {
    await db.loginAttempt.update({
      where: { email },
      data: { lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS) },
    });
  }
}

/**
 * Clear the lockout counter — called on successful sign-in. Idempotent;
 * deleting a non-existent row is a no-op via deleteMany.
 */
export async function clearFailures(email: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email } });
}
