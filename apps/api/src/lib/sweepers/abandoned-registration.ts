import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";
import { invalidateSuperAdminAggregates } from "@/lib/queries";

/**
 * Reap tenants that were minted by an unfinished registration and abandoned.
 *
 * `POST /api/register` COMMITS an Organization + User + Workspace + the whole
 * default catalog (flag defs, stages, #general, membership) BEFORE the OTP is
 * sent — `emailVerified: false` is set, but the rows are already durable. The
 * OAuth path does the same in its `user.create.before` hook, which mints an
 * Organization from its own request and has no compensating delete if Better
 * Auth's subsequent User insert fails. Nothing reaped either one.
 *
 * That left three real problems, all reachable at the register bucket's
 * 5/min/IP with plus-addressed variants of a single mailbox:
 *
 *   - the platform console's pending queue (`take: 8, orderBy createdAt desc`)
 *     fills with junk and real signups fall off it entirely;
 *   - every registration calls `invalidateSuperAdminAggregates()`, so the memo
 *     is permanently cold and each operator page load re-runs the full
 *     per-workspace `_count.messages` scan;
 *   - the rows were removable only one at a time, by hand.
 *
 * WHAT IT DELETES — deliberately narrow, because deleting a real customer's
 * org would be unforgivable. An organization qualifies only if ALL hold:
 *
 *   - it is not the platform anchor (`isPlatform: false`);
 *   - `status` is still `pending` — an approved or suspended org is a decision
 *     an operator made and is never touched here;
 *   - it is older than GRACE_MS (7 days), so a slow real signup has a week to
 *     verify;
 *   - NOBODY in it ever verified an email. One verified user means a real
 *     person got in, whatever the org status says;
 *   - it holds NO conversations, NO contacts and NO channel connections.
 *     Any of those means real work happened and this is not an abandoned shell.
 *
 * Deletion goes through the SAME `destroyOrganization` path an operator's
 * manual delete uses — injected rather than imported, because that service
 * owns the bounded message pre-drain, the R2 blob cleanup, the provider-cache
 * bust and the socket kick. A second implementation of "destroy a tenant" is
 * exactly the class of bug the workspace-delete audit already found once.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Offset from the other daily sweepers so they don't land together. */
const INITIAL_DELAY_MS = 9 * 60 * 1000;
/** How long an unverified pending org gets before it counts as abandoned. */
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-tick ceiling — a flood is drained over several nights, not in one lock. */
const MAX_PER_SWEEP = 200;

type DestroyOrganization = (organizationId: string, label: string) => Promise<void>;

let destroyOrganization: DestroyOrganization | null = null;
let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

/**
 * Injected at boot by the worker service, which can reach the Nest container.
 * Without it the sweeper no-ops rather than growing a second delete path.
 */
export function setAbandonedRegistrationDestroyer(fn: DestroyOrganization): void {
  destroyOrganization = fn;
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("abandoned-registration", sweepAbandonedRegistrationsOnce);
  } catch (err) {
    if (isPoolClosedError(err)) {
      stopAbandonedRegistrationSweeper();
      return;
    }
    console.error(`[sweeper.abandoned-registration] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startAbandonedRegistrationSweeper(): void {
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

export function stopAbandonedRegistrationSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One pass. Returns how many organizations were destroyed — exported so a test
 * or an ops one-off can run it without waiting for the timer.
 */
export async function sweepAbandonedRegistrationsOnce(): Promise<number> {
  if (!destroyOrganization) return 0;

  const cutoff = new Date(Date.now() - GRACE_MS);
  const candidates = await db.organization.findMany({
    where: {
      isPlatform: false,
      status: "pending",
      createdAt: { lt: cutoff },
      // Not one verified mailbox in the whole org.
      users: { none: { emailVerified: true } },
      // No real work anywhere in it.
      workspaces: {
        none: {
          OR: [
            { conversations: { some: {} } },
            { contacts: { some: {} } },
            { channelConnections: { some: {} } },
          ],
        },
      },
    },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
    take: MAX_PER_SWEEP,
  });
  if (candidates.length === 0) return 0;

  let destroyed = 0;
  for (const org of candidates) {
    try {
      await destroyOrganization(org.id, "abandoned-registration-sweep");
      destroyed += 1;
    } catch (err) {
      // Per-tenant isolation: one failure must not skip the rest for a day.
      console.warn(
        `[sweeper.abandoned-registration] destroy failed for org=${org.id}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (destroyed > 0) {
    // The roster and the pending queue both just changed.
    invalidateSuperAdminAggregates();
    console.warn(
      `[sweeper.abandoned-registration] destroyed ${destroyed} abandoned pending organization(s)`,
    );
  }
  return destroyed;
}
