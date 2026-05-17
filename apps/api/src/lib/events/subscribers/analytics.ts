// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context.

/**
 * Analytics subscriber.
 *
 * Updates the conversation analytics columns (firstAssignedAt,
 * firstResponseAt, closedAt, assignmentsCount, *_messages_count, etc.) in
 * response to domain events. Drives the workflow `conversation_closed`
 * trigger's exposed variables.
 *
 * Order in the subscriber chain: AFTER socket-fanout, BEFORE
 * workflow-dispatch. The workflow snapshot must see the analytics-updated
 * row, so this subscriber commits FIRST.
 *
 * Every helper inside `conversationsService` is fire-and-forget at the
 * function level (errors logged, never thrown), so a degraded analytics
 * path can never block a primary state mutation. We still `await` here so
 * the workflow-dispatch subscriber that follows reads fresh state.
 */

import { subscribe } from "@/lib/events/bus";
import { conversationsService } from "@/lib/conversations";

export function registerAnalyticsSubscribers(): void {
  subscribe("conversation.assigned", async (e) => {
    if (e.previousAssignedUserId === e.newAssignedUserId) return;
    await conversationsService.trackOnAssigned({
      conversationId: e.conversationId,
      teamId: e.teamId,
      assignedUserId: e.newAssignedUserId,
      previousAssignedUserId: e.previousAssignedUserId,
    });
  });

  subscribe("conversation.status_changed", async (e) => {
    if (e.previousStatus === e.newStatus) return;
    await conversationsService.trackOnStatusChanged({
      conversationId: e.conversationId,
      teamId: e.teamId,
      previousStatus: e.previousStatus,
      newStatus: e.newStatus,
      // System-driven transitions (e.g. reopen on inbound) carry null
      // changedByUserId; trackOnStatusChanged tolerates it.
      changedByUserId: e.changedByUserId,
      // Step-driven closures (workflow close_conversation step) attach
      // category + free-text summary; trackOnStatusChanged persists them
      // alongside closedAt when newStatus === "closed".
      ...(e.closedCategory !== undefined ? { closedCategory: e.closedCategory } : {}),
      ...(e.closedSummary !== undefined ? { closedSummary: e.closedSummary } : {}),
    });
  });

  subscribe("message.sent", async (e) => {
    // First-response stamping happens here — trackOnOutboundMessage detects
    // whether this is the first outbound since the last inbound and only
    // then bumps firstResponseAt. Bumps outgoingMessagesCount unconditionally.
    await conversationsService.trackOnOutboundMessage({
      conversationId: e.conversationId,
      teamId: e.teamId,
      senderUserId: e.senderUserId,
    });
  });
}
