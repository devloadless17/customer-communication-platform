import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import {
  inboxViewIsViewerScoped,
  type InboxViewFilters,
} from "@ccp/shared/inbox-views/types";

import { DbService } from "../db/db.service";
import { inboxViewWhere } from "@/lib/inbox-views/where";
import {
  visibilityScopeKey,
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";

export interface InboxViewCount {
  total: number;
  unread: number;
}

/**
 * Badge counts for saved inbox views.
 *
 * DELIBERATELY A SEPARATE ENDPOINT from `ConversationsService.counts()`, which
 * serves the six built-in presets. Two reasons, both about protecting the
 * hottest surface in the app:
 *
 *  - COST. Presets are a fixed 11 queries. Views are unbounded-ish (capped at
 *    30 per scope) × 2. Folding them in would make the preset badges — the
 *    ones that must move the instant YOU close a thread — pay for whatever
 *    filters the team happens to have saved.
 *
 *  - CADENCE. Preset counts are instant-feedback: you act, the number moves.
 *    View counts are ambient. The client coalesces them on a much longer
 *    window (see `use-inbox-view-counts.ts`), and this cache's TTL matches
 *    that, so a busy workspace pays one round every few seconds regardless of
 *    message volume rather than one per inbound message per agent.
 *
 * The sharing trick is the same one that makes `teamCounts` affordable, and it
 * is applied PER VIEW rather than to the whole block: a view that doesn't say
 * `me` produces the same number for every agent, so one query serves the whole
 * team. Only views that resolve `me` are counted per viewer.
 */
@Injectable()
export class InboxViewCountsService {
  constructor(private readonly db: DbService) {}

  /**
   * 2.5s. Long enough that a burst of inbound traffic collapses to one round,
   * short enough that a view badge is never visibly wrong for more than a
   * blink. Unlike the preset TTL (250ms) this can afford to be generous —
   * nothing here is feedback on the user's own action.
   */
  private static readonly TTL_MS = 2_500;

  /**
   * Above this many entries, prune everything already expired.
   *
   * Unlike the preset counts cache — keyed by workspace, so it is bounded by
   * tenant count — this one is keyed by the FILTER DOCUMENT, so every edit to
   * a view mints a key that is never looked up again. Grow-only was fine for
   * the caches CLAUDE.md §16 defers eviction on; it is not fine here, because
   * the key space grows with user editing rather than with tenants. The prune
   * is O(n) but only runs when the map is already oversized, and every entry
   * older than the (2.5s) TTL is dead by definition.
   */
  private static readonly MAX_CACHE_ENTRIES = 2_000;

  private readonly cache = new Map<string, { at: number; value: InboxViewCount }>();
  private readonly inFlight = new Map<string, Promise<InboxViewCount>>();

  /**
   * Count every supplied view. Callers pass the views they already loaded, so
   * this never re-reads the InboxView table.
   */
  async countAll(
    workspaceId: string,
    views: Array<{ id: string; filters: InboxViewFilters }>,
    viewer: ConversationViewer,
  ): Promise<Record<string, InboxViewCount>> {
    // One flat fan-out rather than per-view sequencing: each entry is at most
    // two indexed COUNTs, and the cache collapses the repeats.
    const entries = await Promise.all(
      views.map(async (v) => [v.id, await this.countOne(workspaceId, v.filters, viewer)] as const),
    );
    return Object.fromEntries(entries);
  }

  private async countOne(
    workspaceId: string,
    filters: InboxViewFilters,
    viewer: ConversationViewer,
  ): Promise<InboxViewCount> {
    const key = this.cacheKey(workspaceId, filters, viewer);

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < InboxViewCountsService.TTL_MS) return hit.value;

    // Share the in-flight promise so the burst every agent's client produces on
    // the same socket event collapses to ONE round of queries.
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const run = this.query(workspaceId, filters, viewer)
      .then((value) => {
        if (this.cache.size >= InboxViewCountsService.MAX_CACHE_ENTRIES) this.prune();
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, run);
    return run;
  }

  /** Drop every entry past its TTL. See MAX_CACHE_ENTRIES. */
  private prune(): void {
    const cutoff = Date.now() - InboxViewCountsService.TTL_MS;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) this.cache.delete(key);
    }
    // If a pathological burst left the map full of LIVE entries, clear it
    // outright rather than growing without bound. Losing a 2.5s cache costs
    // one extra round of counts; leaking does not stop.
    if (this.cache.size >= InboxViewCountsService.MAX_CACHE_ENTRIES) this.cache.clear();
  }

  private async query(
    workspaceId: string,
    filters: InboxViewFilters,
    viewer: ConversationViewer,
  ): Promise<InboxViewCount> {
    const viewClause = inboxViewWhere(filters, viewer.userId);
    const restriction = visibilityWhere(viewer);

    // AND, never a spread. The view can set `assignedUserId: null`
    // (Unassigned) and the restriction sets `assignedUserId: <agent>`; merged
    // by spread the restriction is silently deleted and a scoped agent's badge
    // counts the whole workspace. Same rule as the list query — see the note
    // in lib/inbox-views/where.ts.
    const base: Prisma.ConversationWhereInput = {
      workspaceId,
      AND: [
        ...(viewClause.AND ? (viewClause.AND as Prisma.ConversationWhereInput[]) : []),
        ...(Object.keys(restriction).length
          ? [restriction as Prisma.ConversationWhereInput]
          : []),
      ],
    };

    // The unread half re-uses the same predicate plus `unreadCount > 0`. Two
    // counts rather than a groupBy: a groupBy over a filtered set would still
    // scan the same rows and returns a shape we'd have to reassemble.
    const [total, unread] = await Promise.all([
      this.db.conversation.count({ where: base }),
      this.db.conversation.count({
        where: { AND: [base, { unreadCount: { gt: 0 } }] },
      }),
    ]);
    return { total, unread };
  }

  /**
   * Cache key.
   *
   * MUST include the visibility scope: keyed by workspace alone, a restricted
   * agent would read an unrestricted teammate's cached total — a leak no WHERE
   * clause can catch, because the query never runs. Same reasoning, and the
   * same bug, as the memo key on `ConversationsService.teamCounts`.
   *
   * The viewer id is included ONLY when the view actually resolves `me`;
   * otherwise every agent shares one entry, which is the whole point.
   */
  private cacheKey(
    workspaceId: string,
    filters: InboxViewFilters,
    viewer: ConversationViewer,
  ): string {
    const scope = visibilityScopeKey(viewer);
    const who = inboxViewIsViewerScoped(filters) ? `u:${viewer.userId}` : "team";
    return `${workspaceId}::${scope}::${who}::${JSON.stringify(filters)}`;
  }
}
