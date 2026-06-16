/**
 * Single monotonic counter shared by every optimistic own-action in the inbox
 * (outbound message bubbles + activity-log pills). The value is a CLIENT-ONLY
 * send-order stamp: it never touches the server, it just lets the timeline sort
 * pinned/in-flight rows by the order the agent created them rather than by
 * client-vs-server wall-clock timestamps (which skew and reorder on reconcile).
 *
 * Why a module-level counter and not a hook/ref: ordering must be consistent
 * across DIFFERENT components in the same tick — the reply box stamps the
 * outbound message, then the same submit dispatches the auto-pause activity
 * pill; both must land in send order. A shared module counter guarantees that
 * without threading state between them. Grow-only by design (a few hundred sends
 * per shift never approaches Number.MAX_SAFE_INTEGER).
 *
 * See Message.optimisticSeq / ConversationActivityEvent.optimisticSeq.
 */
let seq = 0;

export function nextOptimisticSeq(): number {
  seq += 1;
  return seq;
}
