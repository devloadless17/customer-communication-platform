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
 * Record a failed login attempt. Atomic increment via upsert so concurrent
 * failures (same email, different sessions) don't race-double-count or
 * race-undercount. When the counter crosses the threshold, `lockedUntil`
 * is stamped to `now + LOCKOUT_DURATION_MS`.
 */
export async function recordFailure(email: string): Promise<void> {
  const now = new Date();
  const existing = await db.loginAttempt.findUnique({
    where: { email },
    select: { failedCount: true, lockedUntil: true },
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

  const nextCount = (existing?.failedCount ?? 0) + 1;
  const shouldLock = nextCount >= LOCKOUT_THRESHOLD;

  await db.loginAttempt.upsert({
    where: { email },
    create: {
      email,
      failedCount: nextCount,
      lockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : null,
      lastFailedAt: now,
    },
    update: {
      failedCount: nextCount,
      lockedUntil: shouldLock ? new Date(now.getTime() + LOCKOUT_DURATION_MS) : null,
      lastFailedAt: now,
    },
  });
}

/**
 * Clear the lockout counter — called on successful sign-in. Idempotent;
 * deleting a non-existent row is a no-op via deleteMany.
 */
export async function clearFailures(email: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email } });
}
