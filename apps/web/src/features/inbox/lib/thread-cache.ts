import type { ConversationWithRefs } from "@ccp/shared/types";

/**
 * Per-thread snapshot stored in the in-memory cache. Mirrors the shape
 * returned by `getConversationWithRefs` (and the matching API endpoint at
 * `/api/inbox/conversation/[id]`) so the cache can be a drop-in for either
 * SSR-seeded or runtime-fetched threads.
 */
export type CachedThread = {
  data: ConversationWithRefs;
  nextOlderCursor: string | null;
};

/**
 * Minimal LRU cache for the inbox workspace. We don't need a full library —
 * the workload is "tens of entries, occasional eviction" and a tiny Map-based
 * implementation is plenty. The Map's iteration order IS the insertion order,
 * so promoting an entry on read just means re-`set`ing it.
 *
 * Wired to optional `onEvict` so the shell can abort any in-flight fetch for
 * an evicted id (otherwise an evicted entry's pending request would land,
 * write back into the cache, and immediately evict something useful).
 */
export class ThreadCache {
  private readonly store = new Map<string, CachedThread>();
  private readonly maxEntries: number;
  private readonly onEvict?: (id: string) => void;

  constructor(maxEntries: number, onEvict?: (id: string) => void) {
    this.maxEntries = Math.max(1, maxEntries);
    this.onEvict = onEvict;
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  get(id: string): CachedThread | undefined {
    const value = this.store.get(id);
    if (value === undefined) return undefined;
    // Promote on read so a thread the agent keeps coming back to doesn't get
    // evicted by a burst of one-off clicks.
    this.store.delete(id);
    this.store.set(id, value);
    return value;
  }

  /**
   * `peek` returns the entry without promoting it. Used by the socket
   * cache-invalidation listener — we don't want a teammate-driven event to
   * shuffle the LRU order on threads the agent hasn't actually visited.
   */
  peek(id: string): CachedThread | undefined {
    return this.store.get(id);
  }

  set(id: string, value: CachedThread): void {
    if (this.store.has(id)) {
      this.store.delete(id);
    } else if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        this.store.delete(oldest);
        this.onEvict?.(oldest);
      }
    }
    this.store.set(id, value);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }

  /**
   * Drop every cached thread except `keepId` (typically the displayed one,
   * which is being refreshed via its own state-resync path). Used on socket
   * reconnect-after-disconnect: any socket-driven patches that fired during
   * the gap missed the cache, so next-click on any cached non-displayed
   * thread would render stale assignment/status. Forcing a refetch on the
   * next visit is the cheapest fix that's guaranteed-correct.
   *
   * Does NOT fire `onEvict` — we want the in-flight fetch for the displayed
   * thread (if any) to keep running.
   */
  clearExcept(keepId: string | null): void {
    for (const id of Array.from(this.store.keys())) {
      if (id !== keepId) this.store.delete(id);
    }
  }

  /**
   * Mutate the cached thread in-place (or no-op if not cached). Use for
   * background socket reconciliations where we just want to keep an already-
   * cached snapshot fresh without disturbing LRU order. Returns true if a
   * value was patched.
   */
  patch(id: string, updater: (current: CachedThread) => CachedThread | null): boolean {
    const current = this.store.get(id);
    if (current === undefined) return false;
    const next = updater(current);
    if (next === null || next === current) return false;
    this.store.set(id, next);
    return true;
  }

  /**
   * Mutate every cached thread in-place via the same updater. Used by
   * cross-thread socket events (`contact:updated`) where the payload
   * doesn't carry a conversationId — the updater's own equality bail
   * (e.g. `prev.contact.id === payload.contact.id`) decides which entries
   * actually mutate. LRU order is preserved.
   */
  patchAll(updater: (current: CachedThread) => CachedThread | null): void {
    for (const [id, current] of this.store) {
      const next = updater(current);
      if (next === null || next === current) continue;
      this.store.set(id, next);
    }
  }
}
