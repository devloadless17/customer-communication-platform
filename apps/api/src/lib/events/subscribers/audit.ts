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

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import { db } from "@/lib/db";
import { subscribe as busSubscribe, SubscriberPriority } from "@/lib/events/bus";
import { recordConversationEvent } from "@/lib/inbox/events";

/**
 * Resolve the conversation for a contact. Contact↔Conversation is 1:1
 * (DB-enforced via `@@unique([teamId, contactId])`), so the result is at most
 * one row. Returns null when the contact was created without a conversation
 * yet (manual create / CSV import that never messaged in) — those mutations
 * have no in-conversation surface to attach an audit row to, so we skip.
 */
async function resolveConversationIdForContact(
  teamId: string,
  contactId: string,
): Promise<string | null> {
  const conv = await db.conversation.findFirst({
    where: { teamId, contactId },
    select: { id: true },
  });
  return conv?.id ?? null;
}

export function registerAuditSubscribers(): void {
  // All audit handlers run at the AUDIT tier (after realtime, before
  // analytics / workflow-dispatch). Bind the priority once so each call
  // below stays terse and the tier can't be forgotten on a new handler.
  const subscribe = <K extends DomainEventType>(
    type: K,
    handler: (e: DomainEventOf<K>) => void | Promise<void>,
  ) => busSubscribe(type, handler, SubscriberPriority.AUDIT);

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
      // Attributed to whoever deleted the note (author or an admin). null only
      // for system/automation deletions, which the timeline renders as "System".
      userId: e.deletedByUserId,
      kind: "note_deleted",
      before: { noteId: e.noteId },
    });
  });

  // Stage changed (Contact-level lifecycle, surfaced in the in-conversation
  // audit because Contact↔Conversation is 1:1). Stage NAMES are resolved at
  // write time so the timeline reads "Lead → Customer" without a future join
  // into ContactStage rows that may have been renamed/deleted by then.
  subscribe("contact.lifecycle_changed", async (e) => {
    if (e.before.stageId === e.after.stageId) return;
    const conversationId = await resolveConversationIdForContact(
      e.teamId,
      e.contactId,
    );
    if (!conversationId) return;
    const stageIds = [e.before.stageId, e.after.stageId].filter(
      (id): id is string => Boolean(id),
    );
    const stages = stageIds.length
      ? await db.contactStage.findMany({
          where: { teamId: e.teamId, id: { in: stageIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(stages.map((s) => [s.id, s.name] as const));
    await recordConversationEvent({
      conversationId,
      teamId: e.teamId,
      userId: e.changedByUserId,
      apiKeyId: e.changedByApiKeyId ?? null,
      kind: "stage_changed",
      before: {
        stageId: e.before.stageId,
        stageName: e.before.stageId ? nameById.get(e.before.stageId) ?? null : null,
      },
      after: {
        stageId: e.after.stageId,
        stageName: e.after.stageId ? nameById.get(e.after.stageId) ?? null : null,
      },
    });
  });

  // Tag added / removed (Contact-level, surfaced in the in-conversation
  // audit via the 1:1). One audit row per tag change so the timeline can
  // render "Added VIP", "Removed Ramadan buyers" as discrete lines instead
  // of an opaque diff. Tag NAMES are resolved at write time so a future
  // rename doesn't garble historical entries.
  subscribe("contact.tag_changed", async (e) => {
    if (e.added.length === 0 && e.removed.length === 0) return;
    const conversationId = await resolveConversationIdForContact(
      e.teamId,
      e.contactId,
    );
    if (!conversationId) return;
    const allTagIds = [...e.added, ...e.removed];
    const tags = await db.tag.findMany({
      where: { teamId: e.teamId, id: { in: allTagIds } },
      select: { id: true, name: true },
    });
    const nameById = new Map(tags.map((t) => [t.id, t.name] as const));
    for (const tagId of e.added) {
      await recordConversationEvent({
        conversationId,
        teamId: e.teamId,
        userId: e.changedByUserId,
        apiKeyId: e.changedByApiKeyId ?? null,
        kind: "tag_added",
        after: { tagId, tagName: nameById.get(tagId) ?? null },
      });
    }
    for (const tagId of e.removed) {
      await recordConversationEvent({
        conversationId,
        teamId: e.teamId,
        userId: e.changedByUserId,
        apiKeyId: e.changedByApiKeyId ?? null,
        kind: "tag_removed",
        before: { tagId, tagName: nameById.get(tagId) ?? null },
      });
    }
  });
}
