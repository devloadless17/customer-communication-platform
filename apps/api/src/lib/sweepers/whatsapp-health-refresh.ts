// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { fetchWhatsappHealthFromGraph } from "@/lib/providers/meta-health";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";

/**
 * Periodic refresh of each team's WhatsApp messaging-limit tier / quality /
 * throughput snapshot from the Graph phone-number node.
 *
 * Meta pushes tier/quality changes via webhooks (parsed in meta.ts →
 * persistWhatsappHealth), which is the primary, real-time path. This sweep is
 * the backstop: it seeds the snapshot for a number connected BEFORE the webhooks
 * were subscribed, and re-syncs a stale one (a dropped webhook, or a tier change
 * Meta didn't push). Gating a 100k broadcast on a stale/absent tier is worse
 * than a periodic poll, so this keeps the snapshot honest without hammering Graph.
 *
 * Cheap: one indexed scan, bounded per tick, and only connections whose snapshot
 * is null or older than the staleness window are refetched — a healthy fleet
 * settles to zero fetches per tick once every number is fresh.
 */

const SWEEP_INTERVAL_MS = 15 * 60_000; // every 15 min
// Refetch a connection whose snapshot is older than this (or null).
const STALE_MS = 6 * 60 * 60_000; // 6h
// Bound per tick so a large fleet can't burst Graph calls; the remainder is
// picked up on subsequent ticks (staleness ordering ensures the oldest first).
const MAX_PER_TICK = 20;
// Fetch a few in parallel — each is an independent Graph GET.
const FETCH_CONCURRENCY = 4;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startWhatsappHealthRefreshSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepWhatsappHealthOnce()
      .catch((err) => {
        // Pool already ended (dev hot-reload / graceful shutdown). The work
        // is simply over — stop the timer instead of logging a stack trace on
        // every remaining tick. `clearInterval` does NOT cancel a tick already
        // in flight, so without this the sweeper keeps querying a closed pool
        // and Prisma logs "Cannot use a pool after calling end on the pool"
        // once per tick for the whole drain.
        if (isPoolClosedError(err)) {
          stopWhatsappHealthRefreshSweeper();
          return;
        }
        console.warn(
          "[whatsapp-health-refresh-sweeper] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopWhatsappHealthRefreshSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exported for the per-account regression spec (same pattern as
// sweepMessageFlagCountsOnce) — production entry is the interval above.
export async function sweepWhatsappHealthOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stale = await db.channelConnection.findMany({
    where: {
      channel: "whatsapp",
      isActive: true,
      OR: [
        { messagingHealthUpdatedAt: null },
        { messagingHealthUpdatedAt: { lt: cutoff } },
      ],
    },
    // Oldest (and never-fetched) first so no connection is starved.
    orderBy: { messagingHealthUpdatedAt: { sort: "asc", nulls: "first" } },
    // The id matters: polling by workspace alone resolves the DEFAULT account,
    // so a stale NON-default number would be re-selected every tick and never
    // actually refreshed (its own messagingHealthUpdatedAt never advances).
    select: { id: true, workspaceId: true },
    take: MAX_PER_TICK,
  });
  if (stale.length === 0) return;

  // Bounded parallelism — mirror the ingest fan-out cap so a burst of Graph GETs
  // can't dominate the event loop / socket budget.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < stale.length) {
      const idx = cursor++;
      const { id, workspaceId } = stale[idx]!;
      try {
        await fetchWhatsappHealthFromGraph(workspaceId, id);
      } catch (err) {
        console.warn(
          `[whatsapp-health-refresh-sweeper] fetch failed for team=${workspaceId} account=${id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, stale.length) }, () => worker()),
  );
}
