// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { syncTemplateCatalog } from "@/lib/templates/catalog-sync";
import { isPoolClosedError } from "@/lib/sweepers/_mutex";

/**
 * Periodic backstop that keeps each workspace's WhatsApp template catalog
 * honest.
 *
 * Meta pushes template STATUS and CATEGORY changes by webhook (the real-time
 * path), and a components edit now triggers a targeted refetch. What no webhook
 * covers is a template being CREATED or DELETED in WhatsApp Manager: until
 * someone happened to open Settings and press "Sync", a template deleted at Meta
 * stayed in the picker (every send failing) and a newly-approved one was
 * invisible to the broadcast composer. Making the catalog's freshness depend on a
 * human remembering to click a button is not a design.
 *
 * Cheap by construction: only workspaces whose catalog is already stale are
 * refetched, oldest first, a bounded number per tick — so a healthy fleet
 * settles to roughly one workspace per tick and a large one is drained over
 * several without ever bursting Graph.
 */

const SWEEP_INTERVAL_MS = 30 * 60_000; // every 30 min
/** Refetch a workspace whose newest row hasn't been touched in this long. */
const STALE_MS = 6 * 60 * 60_000; // 6h
/** Bound per tick; the remainder is picked up on later ticks (oldest first). */
const MAX_PER_TICK = 5;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export function startTemplateCatalogRefreshSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    sweepOnce()
      .catch((err) => {
        // Pool already ended (dev hot-reload / graceful shutdown). The work
        // is simply over — stop the timer instead of logging a stack trace on
        // every remaining tick. `clearInterval` does NOT cancel a tick already
        // in flight, so without this the sweeper keeps querying a closed pool
        // and Prisma logs "Cannot use a pool after calling end on the pool"
        // once per tick for the whole drain.
        if (isPoolClosedError(err)) {
          stopTemplateCatalogRefreshSweeper();
          return;
        }
        console.warn(
          "[template-catalog-refresh-sweeper] iteration failed:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopTemplateCatalogRefreshSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function sweepOnce(): Promise<void> {
  // Candidates are workspaces with a live WhatsApp connection that carries a
  // WABA — without one there is no catalog to read.
  const connections = await db.channelConnection.findMany({
    where: { channel: "whatsapp", isActive: true, NOT: { wabaId: null } },
    select: { workspaceId: true },
    distinct: ["workspaceId"],
  });
  if (connections.length === 0) return;

  const cutoff = new Date(Date.now() - STALE_MS);
  const due: string[] = [];
  for (const { workspaceId } of connections) {
    // The most recently synced row IS the workspace's catalog freshness: every
    // row in a WABA is stamped by the same reconcile pass. A workspace with no
    // rows at all has never synced and is always due.
    const newest = await db.messageTemplate.findFirst({
      where: { workspaceId },
      orderBy: { syncedAt: "desc" },
      select: { syncedAt: true },
    });
    if (!newest || newest.syncedAt < cutoff) due.push(workspaceId);
    if (due.length >= MAX_PER_TICK) break;
  }
  if (due.length === 0) return;

  // Serial, not parallel: each sync pages a whole catalog across every WABA the
  // workspace has. This is a background backstop with hours of slack — there is
  // nothing to gain from making it burst.
  for (const workspaceId of due) {
    try {
      const outcome = await syncTemplateCatalog(workspaceId);
      // Only wake clients when something actually moved. A no-op refresh must not
      // cost every open tab a refetch.
      if (outcome.syncedCount > 0 || outcome.prunedCount > 0) {
        await publish({
          type: "team.catalog_changed",
          workspaceId,
          scope: "whatsapp-templates",
        });
      }
      if (outcome.failed.length > 0) {
        console.warn(
          `[template-catalog-refresh-sweeper] workspace=${workspaceId} unreachable WABA(s): ` +
            outcome.failed.map((f) => `${f.wabaId}: ${f.error}`).join("; "),
        );
      }
    } catch (err) {
      console.warn(
        `[template-catalog-refresh-sweeper] sync failed for workspace=${workspaceId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
