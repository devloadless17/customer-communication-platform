import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import type { RealtimeEmitter } from "./emitter.service";

/**
 * Bus → wire-emit table. Single source of truth for "which domain event
 * fans out as which Socket.io event, with what payload."
 *
 * Each rule preserves per-event type safety via the `defineRule<K>` helper
 * — the handler receives `DomainEventOf<K>` for whatever K it declares, so
 * field renames/payload drift get caught at compile time. The service
 * (`realtime-fanout.service.ts`) is just the wiring loop that iterates
 * this table and subscribes each rule to the bus in `"any"` mode.
 *
 * Mode rationale: `"any"` (vs `"local"`) means events forwarded from
 * another process (e.g. a Redis bus bridge if we ever add one) also reach
 * connected browsers. Today no bridge exists; `"any"` reduces to `"local"`
 * automatically without a code change when one shows up.
 */

type Handler<K extends DomainEventType> = (
  event: DomainEventOf<K>,
  emitter: RealtimeEmitter,
) => void | Promise<void>;

export type FanoutRule = {
  [K in DomainEventType]: { type: K; handle: Handler<K> };
}[DomainEventType];

function defineRule<K extends DomainEventType>(
  type: K,
  handle: Handler<K>,
): FanoutRule {
  return { type, handle } as FanoutRule;
}

export const FANOUT_RULES: FanoutRule[] = [
  // ---- messages ---------------------------------------------------------
  defineRule("message.received", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: e.message,
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadDelta: e.unreadDelta,
      ...(e.newConversation ? { newConversation: e.newConversation } : {}),
    });
    // Reopen broadcast — a previously-closed conversation flipped to
    // `pending` on this inbound. Tell live clients so the row jumps from
    // "Closed" back into triage without a refetch.
    if (e.reopened) {
      emitter.emitToTeam(e.teamId, "conversation:status", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        status: "pending",
      });
    }
  }),

  defineRule("message.sent", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: e.message,
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadDelta: e.unreadDelta,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
      ...(e.newConversation ? { newConversation: e.newConversation } : {}),
    });
  }),

  defineRule("message.status_changed", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      status: e.status,
    });
  }),

  defineRule("message.media_ready", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:media:ready", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      ...(e.media ? { media: e.media } : {}),
    });
  }),

  // ---- conversations ----------------------------------------------------
  defineRule("conversation.assigned", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:assigned", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      assignedUser: e.assignedUser,
    });
  }),

  defineRule("conversation.status_changed", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      status: e.newStatus,
    });
  }),

  defineRule("conversation.deleted", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:deleted", {
      teamId: e.teamId,
      conversationId: e.conversationId,
    });
  }),

  defineRule("conversation.read", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:read", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      readByUserId: e.readByUserId,
    });
  }),

  // Audit timeline row landed — push to live history-panel viewers.
  defineRule("conversation.event_recorded", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:event", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      event: e.event,
    });
  }),

  // ---- contacts ---------------------------------------------------------
  defineRule("contact.updated", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "contact:updated", {
      teamId: e.teamId,
      contact: e.contact,
    });
  }),

  defineRule("contact.deleted", (e, emitter) => {
    for (const cid of e.conversationIds) {
      emitter.emitToTeam(e.teamId, "conversation:deleted", {
        teamId: e.teamId,
        conversationId: cid,
      });
    }
    emitter.emitToTeam(e.teamId, "contact:deleted", {
      teamId: e.teamId,
      contactId: e.contactId,
    });
  }),

  // ---- notes ------------------------------------------------------------
  defineRule("note.created", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "note:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      note: e.note,
    });
  }),

  defineRule("note.deleted", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "note:deleted", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      noteId: e.noteId,
    });
  }),

  // ---- broadcasts -------------------------------------------------------
  defineRule("broadcast.status_changed", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "broadcast:status", {
      teamId: e.teamId,
      broadcastId: e.broadcastId,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    });
  }),

  defineRule("broadcast.progress", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "broadcast:progress", {
      teamId: e.teamId,
      broadcastId: e.broadcastId,
      sentCount: e.sentCount,
      failedCount: e.failedCount,
      totalCount: e.totalCount,
    });
  }),

  // Broadcast-only mirrors of message.sent / conversation.status_changed.
  // Live on their own types so analytics + audit subscribers stay out (see
  // lib/broadcast-runner.ts head comment for rationale).
  defineRule("broadcast.recipient_message_sent", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: e.message,
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadDelta: 0,
    });
  }),

  defineRule("broadcast.conversation_reopened", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      status: "pending",
    });
  }),

  // ---- team_channel.* (internal channels) -------------------------------
  defineRule("team_channel.message_created", (e, emitter) => {
    const threadRootId = e.message.threadRootId;
    emitter.emitToTeam(e.teamId, "team:channel:message", {
      teamId: e.teamId,
      channelId: e.channelId,
      message: e.message,
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
    });
    if (threadRootId) {
      emitter.emitToTeam(e.teamId, "team:channel:thread:reply", {
        teamId: e.teamId,
        channelId: e.channelId,
        rootMessageId: threadRootId,
        replyCount: e.threadReplyCount,
        lastReplyAt: e.message.createdAt,
      });
      emitter.emitToChannelThread(threadRootId, "team:channel:message", {
        teamId: e.teamId,
        channelId: e.channelId,
        message: e.message,
        preview: null,
        lastMessageAt: null,
        ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
      });
    }
  }),

  defineRule("team_channel.message_edited", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:message:edited", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      body: e.body,
      editedAt: e.editedAt,
    });
  }),

  defineRule("team_channel.message_deleted", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:message:deleted", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      threadRootId: e.threadRootId,
    });
  }),

  defineRule("team_channel.reaction_changed", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:reaction:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      emoji: e.emoji,
      userIds: e.userIds,
    });
  }),

  defineRule("team_channel.pin_changed", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:pin:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      pinned: e.pinned,
    });
  }),

  defineRule("team_channel.read", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:read", {
      teamId: e.teamId,
      channelId: e.channelId,
      readByUserId: e.readByUserId,
      lastReadAt: e.lastReadAt,
    });
  }),

  // ---- team-wide --------------------------------------------------------
  defineRule("team.catalog_changed", (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:catalog:changed", {
      teamId: e.teamId,
      scope: e.scope,
    });
  }),
];
