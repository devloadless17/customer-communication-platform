import { db } from "@/lib/db";
import { kickOutbox, publishInTx } from "@/lib/events/outbox";
import { markFirstResponse, routeMessageToTicket } from "@/lib/tickets/mutations";
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
    // Attach the reply to the thread's active ticket and stop its
    // first-response clock. Here rather than in each `send-*-internal.ts`
    // because this is already THE single post-send commit — five copies of
    // this would drift the same way the monotonicity check once did.
    //
    // Routing NEVER resurrects a solved ticket in either direction (auto-
    // reopen was removed 2026-08-01; `routeMessageToTicket` only ATTACHES to
    // the active ticket): an agent's follow-up on closed work is not new
    // work. If there is no active ticket the reply simply carries none.
    //
    // BROADCASTS DO NOT REACH HERE, and that is load-bearing. The runner writes
    // its rows through `createOutboundMessageIdempotent` alone, so a 1k-recipient
    // campaign opens ZERO tickets — same reasoning as the §18 rule that keeps
    // audit and workflows off `broadcast.*`. A customer who REPLIES to a
    // campaign does open one, via ingest, which is exactly right: the reply is
    // the work, the blast isn't.
    const routed = await routeMessageToTicket(tx, {
      workspaceId: args.event.workspaceId,
      conversationId: args.conversationId,
    });
    if (routed.ticketId) {
      await tx.message.update({
        where: { id: args.event.message.id },
        data: { ticketId: routed.ticketId },
      });
      // First response means someone RESPONDED — an agent, or a partner acting
      // through /v1. A workflow's auto-acknowledgment (senderUserId AND
      // senderApiKeyId both null) must not stamp it: a workspace with an
      // auto-reply workflow would never measure — or breach — human first
      // response on any ticket.
      if (args.event.senderUserId || args.event.senderApiKeyId) {
        await markFirstResponse(tx, args.event.workspaceId, routed.ticketId, effectiveBump);
      }
    }

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
