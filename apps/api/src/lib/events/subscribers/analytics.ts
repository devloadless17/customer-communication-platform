// Note: no `server-only` import — loaded by the NestJS api process via
// @swc-node/register, outside the Next bundler context.

/**
 * Analytics subscriber.
 *
 * Updates the conversation analytics columns (firstAssignedAt,
 * firstResponseAt, closedAt, assignmentsCount, *_messages_count, etc.) in
 * response to domain events. Drives the workflow `conversation_closed`
 * trigger's exposed variables.
 *
 * Every track* helper is fire-and-forget at the function level (errors
 * logged, never thrown), so a degraded analytics path can never block a
 * primary state mutation. We still `await` so the workflow-dispatch
 * subscriber that follows reads fresh state.
 */

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import { subscribe as busSubscribe, SubscriberPriority } from "@/lib/events/bus";
import {
  trackOnAssigned,
  trackOnStatusChanged,
  trackOnOutboundMessage,
} from "@/lib/conversations/analytics";

export function registerAnalyticsSubscribers(): () => void {
  // ANALYTICS tier — runs after audit, before workflow-dispatch +
  // outbound-webhooks (both re-read the state these handlers write).
  const offs: Array<() => void> = [];
  const subscribe = <K extends DomainEventType>(
    type: K,
    handler: (e: DomainEventOf<K>) => void | Promise<void>,
  ) => {
    offs.push(busSubscribe(type, handler, SubscriberPriority.ANALYTICS));
  };

  subscribe("conversation.assigned", async (e) => {
    if (e.previousAssignedUserId === e.newAssignedUserId) return;
    await trackOnAssigned({
      conversationId: e.conversationId,
      teamId: e.teamId,
      assignedUserId: e.newAssignedUserId,
      previousAssignedUserId: e.previousAssignedUserId,
    });
  });

  subscribe("conversation.status_changed", async (e) => {
    if (e.previousStatus === e.newStatus) return;
    await trackOnStatusChanged({
      conversationId: e.conversationId,
      teamId: e.teamId,
      previousStatus: e.previousStatus,
      newStatus: e.newStatus,
      // System-driven transitions (e.g. reopen on inbound) carry null
      // changedByUserId; trackOnStatusChanged tolerates it.
      changedByUserId: e.changedByUserId,
      // External /v1 + workflow closes carry an API-key actor instead of a
      // user; mirror it onto closedByApiKeyId on the same close write.
      changedByApiKeyId: e.changedByApiKeyId ?? null,
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
    await trackOnOutboundMessage({
      conversationId: e.conversationId,
      teamId: e.teamId,
      senderUserId: e.senderUserId,
    });
  });

  return () => {
    for (const off of offs) off();
  };
}
