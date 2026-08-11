// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

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
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopBroadcastDeliveryDriftSweeper();
      return;
    }
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

/** Exported for the spec — one full pass, no timers. */
export async function sweepBroadcastDeliveryDriftOnce(): Promise<void> {
  return sweepOnce();
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
    // workspaceId comes along so the join below can lean on the Message dedupe index
    // (workspaceId, channel, externalId) instead of seq-scanning the whole table.
    select: { id: true, workspaceId: true },
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
        -- workspaceId scopes the join onto the leading column of Message's
        -- (workspaceId, channel, externalId) unique index, turning a full-table scan
        -- into a per-team index range scan. NOT constrained on channel: a
        -- customer-mode broadcast sends each recipient on their best channel, so
        -- m.channel can differ from broadcast.channel — matching on it would
        -- silently skip those recipients.
        WHERE m."workspaceId" = ${b.workspaceId}
          AND m."externalId" = r."externalId"
          AND r."broadcastId" = ${b.id}
          AND r."externalId" IS NOT NULL
          AND r.status = 'sent'
          -- Promote only. Never leave a terminal state, never move backwards.
          AND r."deliveryState" NOT IN ('failed_at_send','undelivered')
          AND (
            (m.status = 'read'      AND r."deliveryState" <> 'read')
            -- Straight-to-read (delivered webhook lost): the row is already
            -- 'read' but deliveredAt was never stamped, and the branch above
            -- can no longer match it — backfill so the delivery curve's
            -- delivered line can't sit below the read line.
            OR (m.status = 'read'   AND r."deliveryState" = 'read' AND r."deliveredAt" IS NULL)
            OR (m.status = 'delivered' AND r."deliveryState" NOT IN ('delivered','read'))
            -- An accepted-then-failed message may only overwrite a state where
            -- delivery was never confirmed; if the handset acked, a late failure
            -- is a Meta duplicate, not a regression. 'held' belongs here too:
            -- a portfolio-paced message the review DROPPED (135000) whose live
            -- recipient write was lost must not stick as accepted/held forever.
            OR (m.status = 'failed'  AND r."deliveryState" IN ('pending','sent','held'))
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

  // ── Parent counters ───────────────────────────────────────────────────────
  // `Broadcast.sentCount` / `failedCount` are runner-maintained increments, and
  // until now nothing reconciled them (audit 2026-08-11): the runner's own
  // comment warns they can end "short of totalCount forever" when a lane dies
  // past its retries, and the campaign report + the progress bar read the
  // COUNTERS while the exactly-countable `BroadcastRecipient` rows hold the
  // truth. So a customer sees "847 of 1,000 sent" on a campaign that fully
  // delivered, permanently.
  //
  // TERMINAL campaigns only. A running/queued campaign's counters are being
  // written concurrently by its lanes, and recomputing under them would
  // reintroduce exactly the lost-update race the increments avoid. The
  // settle guard keys on COALESCE(completedAt, createdAt): Broadcast has NO
  // `updatedAt` column — the first version referenced one, so this statement
  // 42703'd on EVERY tick and the fail-soft catch below ate it; the feature
  // shipped dead until its first spec ran (2026-08-11, session 2). A checker
  // lesson repeated: Prisma raw SQL is invisible to the typechecker.
  //
  // The cancel marker is counted as failed deliberately — cancel() bumps
  // `failedCount` by the rows it marked, so the recount must agree with the
  // writer it is reconciling rather than inventing a third opinion.
  let countersFixed = 0;
  try {
    // Aggregate ONLY the campaigns this tick already selected (recent
    // terminal, <=50) — the first version had no WHERE in the subquery and
    // full-scanned + grouped the ENTIRE BroadcastRecipient table every 6h
    // even when nothing needed fixing (completeness review 2026-08-11; this
    // codebase deliberately supports 100k-recipient campaigns). Campaigns
    // older than RECENT_MS are out of reconcile scope by the same documented
    // posture as the recipient-state half above.
    const ids = broadcasts.map((b) => b.id);
    countersFixed = Number(await db.$executeRaw`
      UPDATE "Broadcast" b
      SET "sentCount" = t.sent, "failedCount" = t.failed
      FROM (
        SELECT r."broadcastId" AS id,
               COUNT(*) FILTER (WHERE r.status = 'sent')   AS sent,
               COUNT(*) FILTER (WHERE r.status = 'failed') AS failed
        FROM "BroadcastRecipient" r
        WHERE r."broadcastId" IN (${Prisma.join(ids)})
        GROUP BY r."broadcastId"
      ) t
      WHERE b.id = t.id
        AND b.status IN ('completed','failed','canceled')
        AND COALESCE(b."completedAt", b."createdAt") < NOW() - INTERVAL '10 minutes'
        AND (b."sentCount" <> t.sent OR b."failedCount" <> t.failed)
    `);
  } catch (err) {
    console.warn(
      "[sweeper.broadcast-delivery-drift] parent-counter reconcile failed; continuing",
      err instanceof Error ? err.message : err,
    );
  }
  if (countersFixed > 0) {
    console.warn(
      `[sweeper.broadcast-delivery-drift] recomputed sent/failed counters on ${countersFixed} terminal campaign(s)`,
    );
  }
}
