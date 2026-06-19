import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

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
    // Mutex serializes against other heavy sweepers + tracks last-completion
    // so the health log can warn if this reconciler hasn't run in >25h.
    await withSweeperMutex("contact-drift", sweepOnce);
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
  // bjadded-1: page PER-TEAM rather than one cross-tenant full-table UPDATE.
  // The old single statement joined the ENTIRE Contact table against the ENTIRE
  // Message table's per-contact MAX(timestamp) — at scale (many teams × millions
  // of messages) that's a long-running, high-lock, whole-table scan in one
  // transaction. Scoping each statement to a single team (via the indexed
  // Message.teamId / Contact.teamId) bounds the footprint and lets unrelated
  // tenants' writes proceed between iterations.
  //
  // Per team: join Contact against the per-contact MAX(timestamp) of inbound
  // messages, update only where the denorm disagrees. `IS DISTINCT FROM` treats
  // NULL as comparable so both drift directions (stale value vs missing value)
  // are caught symmetrically. Message has no contactId — it joins through
  // Conversation.
  const teams = await db.team.findMany({ select: { id: true } });
  let totalDrifted = 0;
  for (const { id: teamId } of teams) {
    // Per-team isolation: a lock-wait / deadlock on one tenant's hot Message
    // table must not throw out of the whole sweep and skip every later-ordered
    // team — with a 24h cadence the next retry is a full day away.
    try {
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
            WHERE m.direction = 'in' AND m."teamId" = ${teamId}
            GROUP BY co."contactId"
          ) actual ON actual.contact_id = c2.id
          WHERE c2."teamId" = ${teamId}
        ) sub
        WHERE c.id = sub.contact_id
          AND c."teamId" = ${teamId}
          AND c."lastInboundAt" IS DISTINCT FROM sub.last_inbound
      `;
      totalDrifted += Number(drifted);
    } catch (err) {
      console.warn(
        `[sweeper.contact-drift] reconcile failed for team=${teamId}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (totalDrifted > 0) {
    console.warn(
      `[sweeper.contact-drift] reconciled ${totalDrifted} contact(s) with stale lastInboundAt across ${teams.length} team(s)`,
    );
  }
}
