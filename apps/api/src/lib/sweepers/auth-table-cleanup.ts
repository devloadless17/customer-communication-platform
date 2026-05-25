import { db } from "@/lib/db";

/**
 * Nightly cleanup of EXPIRED Better Auth rows: `Session` and `Verification`.
 *
 * Better Auth treats an expired session/verification row as invalid on READ
 * (it checks `expiresAt` before honoring it) but does NOT delete the row — it
 * expects the app to prune. Left alone, every expired session (90-day cap,
 * re-created on each device sign-in) and every consumed/expired verification
 * token lingers forever. Not a correctness bug (expired rows never authorize),
 * just unbounded table growth. F5 in docs/architecture-review-2026-05-25.md.
 *
 * Active sessions are NOT touched — only rows already past `expiresAt`, so a
 * signed-in user can't be logged out by this sweep. (`Account` is intentionally
 * excluded: it's the credential record, not a TTL'd token — deleting it would
 * lock the user out.)
 *
 * Mirrors the other sweepers: one set-based DELETE per table, 24h, no clever
 * self-disabling. Both DELETEs hit the `@@index([expiresAt])` / `([identifier])`
 * indexes — cheap even when the tables are large.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 7 * 60 * 1000; // 7min after boot — staggered behind the drift sweeps

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sweepOnce();
  } catch (err) {
    console.error(`[sweeper.auth-cleanup] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startAuthTableCleanupSweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => {
      void runTick("sweep");
    }, SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopAuthTableCleanupSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const now = new Date();

  const sessions = await db.session.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  const verifications = await db.verification.deleteMany({
    where: { expiresAt: { lt: now } },
  });

  const total = sessions.count + verifications.count;
  if (total > 0) {
    console.warn(
      `[sweeper.auth-cleanup] deleted ${sessions.count} expired session(s) + ` +
        `${verifications.count} expired verification(s)`,
    );
  }
}
