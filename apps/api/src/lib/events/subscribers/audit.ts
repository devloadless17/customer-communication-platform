// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context.

/**
 * Audit subscriber.
 *
 * Writes a `ConversationEvent` row for every meaningful state mutation via
 * `recordConversationEvent` in lib/inbox/events.ts.
 *
 * No-ops on no-change transitions ("Assign to me" on an already-self-assigned
 * thread, status set to current value) so the timeline doesn't churn.
 *
 * INVARIANT — DO NOT subscribe to `broadcast.*` events here.
 * --------------------------------------------------------------------------
 * `broadcast.recipient_message_sent` and `broadcast.conversation_reopened`
 * exist so a 1k-recipient broadcast does NOT write 1k audit rows. Only
 * socket-fanout subscribes to them. Adding an audit subscription would
 * silently re-introduce the timeline-spam bug those events were created
 * to prevent. See CLAUDE.md "Bus events introduced for the cleanup".
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
      // External /v1 mutations set changedByApiKeyId so the audit row
      // attributes the change to the API key. Mutually exclusive with
      // userId in practice — partner integrations have no human author.
      apiKeyId: e.changedByApiKeyId ?? null,
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
      apiKeyId: e.changedByApiKeyId ?? null,
      kind: "status_changed",
      before: { status: e.previousStatus },
      after: { status: e.newStatus },
    });
  });

  // Note added / deleted — audit so an admin can trace who added/removed a
  // teammate's note. Note bodies themselves stay off the audit row (the row
  // may outlive the note via retention policy); we keep just the noteId + a
  // short body excerpt so the history-panel entry is readable without
  // forcing a join into a deleted table.
  subscribe("note.created", async (e) => {
    await recordConversationEvent({
      conversationId: e.conversationId,
      teamId: e.teamId,
      userId: e.note.authorUserId,
      kind: "note_added",
      after: {
        noteId: e.note.id,
        // Truncate so a 10k-char note doesn't bloat every audit row.
        excerpt: e.note.body.slice(0, 140),
      },
    });
  });

  subscribe("note.deleted", async (e) => {
    await recordConversationEvent({
      conversationId: e.conversationId,
      teamId: e.teamId,
      // note.deleted carries no deletedByUserId today — the bus event only
      // ships ids. Leave userId null so the timeline reads "Note deleted"
      // attributed to the team, not falsely attributed to the author.
      userId: null,
      kind: "note_deleted",
      before: { noteId: e.noteId },
    });
  });
}
