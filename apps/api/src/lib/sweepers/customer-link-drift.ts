import { db } from "@/lib/db";
import { resolveCustomerId } from "@/lib/identity/identity-service";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

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
    // `identityChannel` so the resolver can apply the ephemeral strong-key rule
    // to this contact as the SUBJECT, not just as a candidate (§6).
    select: {
      id: true,
      workspaceId: true,
      phoneNumber: true,
      email: true,
      name: true,
      identityChannel: true,
    },
    // ORDERED — every other paged sweeper is, and this one's absence was a
    // starvation bug: a contact `resolveCustomerId` throws on permanently
    // occupies a slot in the unordered window, so at a 60s cadence the same
    // failing rows are re-selected forever and every orphan behind them is
    // never reached. Newest-first also matches the intent stated at the top of
    // this file ("a just-created contact gets its unified profile fast").
    orderBy: { createdAt: "desc" },
    take: BATCH,
  });
  for (const c of orphans) {
    try {
      const customerId = await resolveCustomerId(c.workspaceId, c);
      // CAS: only link if still unlinked.
      const linked = await db.contact.updateMany({
        where: { id: c.id, customerId: null },
        data: { customerId },
      });
      // If inline linking (or a concurrent sweep) won the CAS, `resolveCustomerId`
      // may have just minted a Customer that now owns no contacts. Reap it — the
      // guard (`contacts: none`) makes this safe whether `customerId` was a fresh
      // customer or an existing strong-key match (an in-use customer is skipped).
      if (linked.count === 0) {
        // No memory adoption needed here (unlike the other reap sites, which
        // call adoptCustomerMemories): a customer this branch deletes was
        // minted by the resolveCustomerId call ABOVE and never rendered — no
        // AiCustomerMemory row can point at it. An existing strong-key match
        // that is in use survives the `contacts: none` guard.
        await db.customer.deleteMany({
          where: { id: customerId, workspaceId: c.workspaceId, contacts: { none: {} } },
        });
      }
    } catch (err) {
      // Pool already ended (dev hot-reload / shutdown) — the work is
      // over, so stop instead of logging a stack trace every tick.
      if (isPoolClosedError(err)) {
        stopCustomerLinkSweeper();
        return;
      }
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
    // Pool already ended (dev hot-reload / graceful shutdown) — STOP rather
    // than log a stack trace every 60s for the whole drain. The per-contact
    // catch inside `sweepOnce` handled this, but the initial `findMany` sits
    // outside it, so a pool-closed error there escaped to here and was only
    // ever console.error'd. Every other sweeper stops itself at this level.
    if (isPoolClosedError(err)) {
      stopCustomerLinkSweeper();
      return;
    }
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
