// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context.

/**
 * Audit subscriber.
 *
 * Writes a `ConversationEvent` row (and fires its own `conversation:event`
 * socket emit) for every meaningful state mutation. Pulls in
 * `recordConversationEvent` from lib/inbox/events.ts so the "audit row +
 * socket emit" pair stays atomic to one helper.
 *
 * Order in the subscriber chain: AFTER socket-fanout (so the primary state
 * change reaches clients first), BEFORE analytics + workflow-dispatch (so
 * the audit row exists if a workflow ever reads from the timeline later).
 *
 * No-ops on no-change transitions ("Assign to me" on an already-self-assigned
 * thread, status set to current value) so the timeline doesn't churn.
 */

import { subscribe } from "@/lib/events/bus";
import { recordConversationEvent } from "@/lib/inbox/events";

export function registerAuditSubscribers(): void {
  subscribe("conversation.assigned", async (e) => {
    if (e.previousAssignedUserId === e.newAssignedUserId) return;
    await recordConversationEvent({
      conversationId: e.conversationId,
      teamId: e.teamId,
      userId: e.changedByUserId,
      kind: "assigned",
      before: { assignedUserId: e.previousAssignedUserId },
      after: { assignedUserId: e.newAssignedUserId },
    });
  });

  subscribe("conversation.status_changed", async (e) => {
    if (e.previousStatus === e.newStatus) return;
    await recordConversationEvent({
      conversationId: e.conversationId,
      teamId: e.teamId,
      userId: e.changedByUserId,
      kind: "status_changed",
      before: { status: e.previousStatus },
      after: { status: e.newStatus },
    });
  });
}
