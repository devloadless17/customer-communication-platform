import { flushSync } from "react-dom";

/**
 * Optimistic conversation-LIST bump — left-sidebar row only.
 *
 * Moves a conversation row to the top of the inbox list with a fresh preview
 * the instant the agent sends, WITHOUT waiting on the server's `message:new`
 * round-trip. On a long-lived tab whose socket missed that frame (laptop
 * sleep / reconnect gap), the sender's own row would otherwise stay pinned to
 * the previous message — most visibly a stale text preview when the new
 * message is a caption-less voice note.
 *
 * Why a dedicated channel instead of `dispatchLocalSocketEvent("message:new")`:
 * `message:new` has FIVE client subscribers (list, displayed thread, stage
 * counts, the contact panel's "Messages" tally, and the shell's LRU cache
 * eviction). Firing a synthetic message:new just to refresh the list also
 * tripped the contact-panel tally — it does `count + 1` with no externalId
 * dedupe, so the synthetic frame plus the real one double-counted. This
 * channel is owned by exactly ONE subscriber (useTeamEvents), so an optimistic
 * send touches only the list — never the thread bubble, the tally, or the
 * cache. The real server `message:new` that follows is absorbed harmlessly:
 * useTeamEvents sets `lastMessagePreview` / `lastMessageAt` absolutely
 * (overwrite-not-add), so the second pass is idempotent.
 *
 * The displayed thread's own optimistic bubble is handled separately by
 * `addOptimistic` in useConversationEvents — this channel deliberately does
 * not paint bubbles.
 */
export interface OptimisticListBump {
  conversationId: string;
  /** Preview text to show on the row (already media-aware + sliced). */
  preview: string;
  /** ISO timestamp used for the recency sort. */
  lastMessageAt: string;
}

type Listener = (bump: OptimisticListBump) => void;

const listeners = new Set<Listener>();

/** Subscribe (useTeamEvents). Returns an unsubscribe fn for effect cleanup. */
export function onOptimisticListBump(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/**
 * Fire an optimistic list bump from a send site. Wrapped in `flushSync` for the
 * same reason `dispatchLocalSocketEvent` is: without it React 18/19's concurrent
 * renderer defers the InboxShell-root list update behind the small subtree
 * updates in the click frame, which surfaces as a ~1s sidebar lag.
 */
export function emitOptimisticListBump(bump: OptimisticListBump): void {
  if (listeners.size === 0) return;
  const run = () => {
    for (const cb of [...listeners]) {
      try {
        cb(bump);
      } catch (err) {
        // A misbehaving subscriber must not break the optimistic UX.
        // eslint-disable-next-line no-console
        console.error("[optimistic-list-bump] subscriber threw", err);
      }
    }
  };
  // flushSync throws if called mid-render; the send sites are all event
  // handlers, so it's safe — fall back to a plain run if a stray caller hits it.
  try {
    flushSync(run);
  } catch {
    run();
  }
}
