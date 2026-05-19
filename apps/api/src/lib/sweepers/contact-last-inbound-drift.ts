import { db } from "@/lib/db";

/**
 * Reconciler for the `Contact.lastInboundAt` denormalization.
 *
 * The denorm is maintained by the inbound ingest path at
 * [providers/ingest.ts](../providers/ingest.ts). A crash between the
 * Message insert and the Contact bump leaves the denorm stale — rare in
 * practice (the writes are colocated and the path is short), but stale
 * denorm = sidebar sort order silently disagrees with the actual last
 * inbound time, with no operator signal until someone notices.
 *
 * Cadence: 24h. Cheap enough to run forever — the UPDATE is a single
 * set-based statement, planner walks the contact table once. At pilot
 * scale (1 customer, < 10k contacts) it's effectively free, and even at
 * 100x that the daily cost is sub-second. An earlier self-disabling
 * variant (after 7 quiet days) was clever-not-correct: the disable state
 * was in-memory only and reset on every process restart, so the savings
 * were marginal and the extra state machine cost more in debug time than
 * the scan ever cost in DB time.
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000; // wait 5min after boot so steady-state work isn't competing

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
// In-flight guard — the reconcile is a single set-based UPDATE so a slow
// tick won't normally overlap with the 24h interval, but the guard is
// cheap and makes the safety contract explicit.
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sweepOnce();
  } catch (err) {
    console.error(`[sweeper.contact-drift] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startContactDriftSweeper(): void {
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

export function stopContactDriftSweeper(): void {
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
  // One-pass: join Contact against the per-contact MAX(timestamp) of
  // inbound messages, update only where the denorm disagrees. Treats
  // both "actual was NULL but contact has a stale value" and "contact
  // is missing a value that should be present" as drift.
  //
  // Message has no contactId column — it joins to Contact through
  // Conversation. Group by Conversation.contactId to land per-contact maxes.
  //
  // IS DISTINCT FROM treats NULL as comparable so the WHERE clause
  // catches both directions of drift symmetrically.
  const drifted = await db.$executeRaw`
    UPDATE "Contact" c
    SET "lastInboundAt" = sub.last_inbound
    FROM (
      SELECT
        c2.id as contact_id,
        actual.max_ts as last_inbound
      FROM "Contact" c2
      LEFT JOIN (
        SELECT co."contactId" AS contact_id, MAX(m."timestamp") AS max_ts
        FROM "Message" m
        JOIN "Conversation" co ON co.id = m."conversationId"
        WHERE m.direction = 'in'
        GROUP BY co."contactId"
      ) actual ON actual.contact_id = c2.id
    ) sub
    WHERE c.id = sub.contact_id
      AND c."lastInboundAt" IS DISTINCT FROM sub.last_inbound
  `;

  if (drifted > 0) {
    console.warn(
      `[sweeper.contact-drift] reconciled ${drifted} contact(s) with stale lastInboundAt`,
    );
  }
}
