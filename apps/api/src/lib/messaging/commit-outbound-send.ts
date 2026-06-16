import { db } from "@/lib/db";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import type { DomainEventOf } from "@ccp/shared/events/types";

/**
 * THE single post-send commit for an outbound message. Was copy-pasted across
 * `MessagesService.commitOutboundEvent` + the three `send-*-internal.ts`
 * senders (with the interactive variant's monotonicity null-check already
 * drifted) — unified here so the contract has exactly one home.
 *
 * In ONE transaction it:
 *  1. reads the conversation's FRESH lastMessageAt/unreadCount — the snapshot
 *     taken before the Meta call is stale by the call duration, so a bare
 *     UPDATE could regress the clock if an inbound landed in that window;
 *  2. computes a strictly-monotonic `lastMessageAt` bump (an outbound landing
 *     in the same second as an inbound still sorts AFTER it, and a concurrent
 *     inbound bump is never clobbered backward);
 *  3. writes the preview + bump;
 *  4. publishes `message.sent` via `publishInTx` so the outbox row commits
 *     ATOMICALLY with the bump — a post-tx `publish()` lost the event entirely
 *     on a crash between commit and publish, and the retry found the externalId
 *     already in the DB so it never re-published.
 *
 * Callers pass the fully-built `message.sent` event MINUS `lastMessageAt` +
 * `unreadCount` (both filled in here from the in-tx read) plus an `onMissing`
 * strategy for a conversation that vanished mid-send: the session-authenticated
 * controller path no-ops (the optimistic bubble's watchdog handles it); the
 * framework-agnostic lib senders throw their own validation error.
 */
export async function commitOutboundSend(args: {
  conversationId: string;
  bumpTimestamp: Date;
  preview: string;
  event: Omit<DomainEventOf<"message.sent">, "lastMessageAt" | "unreadCount">;
  onMissing: () => void;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const current = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: { lastMessageAt: true, unreadCount: true },
    });
    if (!current) {
      args.onMissing();
      return;
    }
    const effectiveBump =
      current.lastMessageAt >= args.bumpTimestamp
        ? new Date(current.lastMessageAt.getTime() + 1)
        : args.bumpTimestamp;
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: {
        lastMessageAt: effectiveBump,
        lastMessagePreview: args.preview,
        lastMessageDirection: "out",
      },
    });
    await publishInTx(tx, {
      ...args.event,
      lastMessageAt: effectiveBump.toISOString(),
      unreadCount: current.unreadCount,
    });
  });
  // Outbox row is committed — dispatch the message.sent fan-out NOW (~1ms)
  // rather than waiting out the drainer poll. Pure latency win (poll is the
  // fallback). See kickOutbox()'s contract in lib/events/outbox.ts.
  kickOutbox();
}
