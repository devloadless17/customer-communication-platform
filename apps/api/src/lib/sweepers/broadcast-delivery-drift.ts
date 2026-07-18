// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Reconciles `BroadcastRecipient.deliveryState` against the `Message` row it
 * denormalizes.
 *
 * Required by the CLAUDE.md rule that any denormalization is backed by a drift
 * sweeper. The live propagation (`applyBroadcastDeliveryStatus` in
 * lib/providers/ingest.ts) is deliberately fire-and-forget so a reporting write
 * can never cost us a delivery receipt — which means it CAN drop a write under
 * pool pressure or a process restart mid-webhook. This is the backstop that
 * makes the campaign funnel eventually-correct anyway.
 *
 * SCOPE IS DELIBERATELY NARROW — the same discipline conversation-analytics-drift
 * documents in its header. Only what re-derives EXACTLY and CHEAPLY:
 *
 *  - Only recipients with `status='sent'` AND a non-null `externalId`. A
 *    recipient that failed at send has no wamid and no Message row to compare
 *    against; its state is already terminal and runner-owned.
 *  - Only broadcasts that finished RECENTLY. Delivery/read receipts trickle for
 *    hours, not weeks, so an old campaign is settled — re-scanning all history
 *    nightly is exactly the cost that header warns about.
 *  - NEVER touches a recipient whose Message row is missing. The runner's
 *    post-send Message create is documented best-effort and can fail, leaving a
 *    legitimately-`sent` recipient with no message. "Correcting" that would be a
 *    guess, and the recipient WAS billed.
 *  - NEVER re-derives reply/click attribution (a later phase's columns). Those
 *    are point-in-time facts recorded under an attribution window that has since
 *    moved; replaying them would produce a different answer on every run. That
 *    is the "heuristic replay" the analytics-drift header explicitly rules out.
 *
 * Never downgrades: the SQL only promotes a recipient UP the ladder, and never
 * moves one off a terminal state, mirroring `deliveryWinsOver`.
 */

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h — receipts settle within hours
const INITIAL_DELAY_MS = 7 * 60 * 1000; // 7min after boot — staggered behind analytics-drift (6min)
/** Only reconcile campaigns that finished inside this window. */
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
/** Bound campaigns per tick so one huge history can't monopolise a sweep. */
const MAX_BROADCASTS_PER_TICK = 50;

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("broadcast-delivery-drift", sweepOnce);
  } catch (err) {
    console.error(`[sweeper.broadcast-delivery-drift] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startBroadcastDeliveryDriftSweeper(): void {
  if (timer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runTick("initial sweep");
    timer = setInterval(() => void runTick("interval sweep"), SWEEP_INTERVAL_MS);
    timer.unref?.();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
}

export function stopBroadcastDeliveryDriftSweeper(): void {
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
  const since = new Date(Date.now() - RECENT_MS);
  const broadcasts = await db.broadcast.findMany({
    where: {
      status: { in: ["completed", "failed", "canceled", "paused"] },
      OR: [{ completedAt: { gte: since } }, { createdAt: { gte: since } }],
    },
    orderBy: { createdAt: "desc" },
    take: MAX_BROADCASTS_PER_TICK,
    select: { id: true },
  });
  if (broadcasts.length === 0) return;

  let totalDrifted = 0;
  // Per campaign, not one cross-history statement: bounds each transaction and
  // keeps a slow tick from holding locks across every team's data at once.
  for (const b of broadcasts) {
    try {
      const drifted = await db.$executeRaw`
        UPDATE "BroadcastRecipient" r
        SET "deliveryState" = CASE m.status
              WHEN 'read'      THEN 'read'::"BroadcastDeliveryState"
              WHEN 'delivered' THEN 'delivered'::"BroadcastDeliveryState"
              WHEN 'failed'    THEN 'undelivered'::"BroadcastDeliveryState"
              ELSE r."deliveryState" END,
            "deliveredAt" = COALESCE(r."deliveredAt",
              CASE WHEN m.status IN ('delivered','read') THEN m."timestamp" ELSE NULL END),
            "readAt" = COALESCE(r."readAt",
              CASE WHEN m.status = 'read' THEN m."timestamp" ELSE NULL END),
            "metaErrorCode" = COALESCE(r."metaErrorCode",
              CASE WHEN m.status = 'failed' THEN m."statusErrorCode" ELSE NULL END)
        FROM "Message" m
        WHERE m."externalId" = r."externalId"
          AND r."broadcastId" = ${b.id}
          AND r."externalId" IS NOT NULL
          AND r.status = 'sent'
          -- Promote only. Never leave a terminal state, never move backwards.
          AND r."deliveryState" NOT IN ('failed_at_send','undelivered')
          AND (
            (m.status = 'read'      AND r."deliveryState" <> 'read')
            OR (m.status = 'delivered' AND r."deliveryState" NOT IN ('delivered','read'))
            -- An accepted-then-failed message may only overwrite a state where
            -- delivery was never confirmed; if the handset acked, a late failure
            -- is a Meta duplicate, not a regression.
            OR (m.status = 'failed'  AND r."deliveryState" IN ('pending','sent'))
          )
      `;
      totalDrifted += Number(drifted);
    } catch (err) {
      console.warn(
        `[sweeper.broadcast-delivery-drift] reconcile failed for broadcast=${b.id}; continuing`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (totalDrifted > 0) {
    console.warn(
      `[sweeper.broadcast-delivery-drift] reconciled ${totalDrifted} recipient(s) with stale delivery state across ${broadcasts.length} campaign(s)`,
    );
  }
}
