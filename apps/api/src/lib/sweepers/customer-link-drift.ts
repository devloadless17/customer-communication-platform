import { db } from "@/lib/db";
import { resolveCustomerId } from "@/lib/identity/identity-service";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Ensures every Contact rolls up to a Customer (unified identity, §6).
 *
 * The primary inbound-ingest path links a new contact inline (nested customer
 * create). Every OTHER create path — manual UI, CSV import, /v1, workflow
 * target, Coexistence echo/history, call events — leaves `customerId` null; this
 * sweeper links them. It's the single reconciler, so those paths stay simple
 * and can never silently produce an unlinked contact.
 *
 * Runs frequently (60s) so a just-created contact gets its unified profile fast;
 * until then the UI treats an unlinked contact as its own single-contact
 * customer (graceful), so there's no broken state in the window.
 *
 * Auto-merge (exact phone/email) happens via `resolveCustomerId`; a CAS on
 * `customerId: null` keeps a race with inline linking safe (no double-link).
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const BATCH = 500;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function sweepOnce(): Promise<void> {
  const orphans = await db.contact.findMany({
    where: { customerId: null, deletedAt: null },
    select: { id: true, teamId: true, phoneNumber: true, email: true, name: true },
    take: BATCH,
  });
  for (const c of orphans) {
    try {
      const customerId = await resolveCustomerId(c.teamId, c);
      // CAS: only link if still unlinked. If inline linking (or a concurrent
      // sweep) won, our just-created customer is orphaned — harmless (it owns
      // no contacts) and cheap to leave.
      await db.contact.updateMany({
        where: { id: c.id, customerId: null },
        data: { customerId },
      });
    } catch (err) {
      console.error(`[sweeper.customer-link] failed for contact ${c.id}`, err);
    }
  }
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("customer-link", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.customer-link] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startCustomerLinkSweeper(): void {
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

export function stopCustomerLinkSweeper(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
