import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reconciler for the `Contact.lastInboundAt` denormalization.
 *
 * The denorm is maintained by the inbound ingest path at
 * [providers/ingest.ts](../providers/ingest.ts), and — since connected
 * user-initiated calls also open the 24h customer-service window — by the
 * call paths ([providers/ingest-call.ts](../providers/ingest-call.ts) and
 * calls.service.ts `answerCall`). A crash between the Message/Call write and
 * the Contact bump leaves the denorm stale — rare in practice (the writes are
 * colocated and the paths are short), but stale denorm = sidebar sort order
 * and the reply-box window gate silently disagree with the actual last
 * inbound interaction, with no operator signal until someone notices.
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
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopContactDriftSweeper();
      return;
    }
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

// Exported for the call-csw-window regression spec (same pattern as
// template-catalog-refresh's sweepOnce) — production entry is the interval.
export async function sweepOnce(): Promise<void> {
  // bjadded-1: page PER-TEAM rather than one cross-tenant full-table UPDATE.
  // The old single statement joined the ENTIRE Contact table against the ENTIRE
  // Message table's per-contact MAX(timestamp) — at scale (many teams × millions
  // of messages) that's a long-running, high-lock, whole-table scan in one
  // transaction. Scoping each statement to a single team (via the indexed
  // Message.workspaceId / Contact.workspaceId) bounds the footprint and lets unrelated
  // tenants' writes proceed between iterations.
  //
  // Per team: join Contact against the per-contact GREATEST of (a) the MAX
  // timestamp of inbound messages, (b) the MAX ringingAt of ALL inbound calls
  // (the calling-pricing doc opens the window "regardless of if you accept
  // the call or not"), and (c) the MAX answeredAt of connected calls of
  // EITHER direction ("when a WhatsApp user accepts your call"). All write
  // paths (providers/ingest.ts, providers/ingest-call.ts + calls.service.ts
  // answerCall) bump the same denorm. Recomputing from a NARROWER set than
  // the write paths would REVERT their bumps as "drift" within 24h.
  // Postgres GREATEST ignores NULLs (null only when all args are null), so a
  // contact with only one signal keeps it. Update only where the denorm
  // disagrees; `IS DISTINCT FROM` treats NULL as comparable so both drift
  // directions (stale value vs missing value) are caught symmetrically.
  // Neither Message nor Call has a contactId — both join through Conversation.
  const teams = await db.workspace.findMany({ select: { id: true } });
  let totalDrifted = 0;
  for (const { id: workspaceId } of teams) {
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
            GREATEST(msg.max_ts, calls.max_ts) as last_inbound
          FROM "Contact" c2
          LEFT JOIN (
            SELECT co."contactId" AS contact_id, MAX(m."timestamp") AS max_ts
            FROM "Message" m
            JOIN "Conversation" co ON co.id = m."conversationId"
            WHERE m.direction = 'in' AND m."workspaceId" = ${workspaceId}
            GROUP BY co."contactId"
          ) msg ON msg.contact_id = c2.id
          LEFT JOIN (
            -- Calling-pricing doc: ANY inbound call opens the window at its
            -- arrival ("regardless of if you accept the call or not"), and a
            -- CONNECTED call of EITHER direction opens it at pickup ("when a
            -- WhatsApp user accepts your call"). GREATEST returns null only
            -- when all args are null, so either signal alone survives.
            SELECT co."contactId" AS contact_id,
              GREATEST(
                MAX(cl."ringingAt") FILTER (WHERE cl.direction = 'in'),
                MAX(cl."answeredAt") FILTER (WHERE cl."answeredAt" IS NOT NULL)
              ) AS max_ts
            FROM "Call" cl
            JOIN "Conversation" co ON co.id = cl."conversationId"
            WHERE cl."workspaceId" = ${workspaceId}
            GROUP BY co."contactId"
          ) calls ON calls.contact_id = c2.id
          WHERE c2."workspaceId" = ${workspaceId}
        ) sub
        WHERE c.id = sub.contact_id
          AND c."workspaceId" = ${workspaceId}
          AND c."lastInboundAt" IS DISTINCT FROM sub.last_inbound
      `;
      totalDrifted += Number(drifted);
    } catch (err) {
      console.warn(
        `[sweeper.contact-drift] reconcile failed for team=${workspaceId}; continuing`,
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
