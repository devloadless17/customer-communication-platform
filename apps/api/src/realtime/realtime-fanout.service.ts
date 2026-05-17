import { Injectable, OnModuleInit } from "@nestjs/common";

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import { EventBus } from "../events/event-bus.module";
import { RealtimeEmitter } from "./emitter.service";

/**
 * Subscribes to the domain event bus and fans events out to socket rooms.
 *
 * Mode is `"any"` for every subscriber so events forwarded from another
 * process (Next.js side during the Phase 2-3 transition window via the
 * Redis bus bridge) reach connected browsers. After Phase 3+ when all
 * event sources live in this process, the bridge can be turned off and
 * `"any"` reduces to `"local"` automatically — no code change required.
 *
 * Migrated 1:1 from lib/events/subscribers/socket-fanout.ts. Behaviour is
 * intentionally identical; the only difference is the emitter is injected
 * instead of imported.
 */
@Injectable()
export class RealtimeFanoutService implements OnModuleInit {
  constructor(
    private readonly bus: EventBus,
    private readonly emitter: RealtimeEmitter,
  ) {}

  onModuleInit(): void {
    this.on("message.received", (e) => {
      this.emitter.emitToTeam(e.teamId, "message:new", {
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
        this.emitter.emitToTeam(e.teamId, "conversation:status", {
          teamId: e.teamId,
          conversationId: e.conversationId,
          status: "pending",
        });
      }
    });

    this.on("message.sent", (e) => {
      this.emitter.emitToTeam(e.teamId, "message:new", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        message: e.message,
        preview: e.preview,
        lastMessageAt: e.lastMessageAt,
        unreadDelta: e.unreadDelta,
        ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
        ...(e.newConversation ? { newConversation: e.newConversation } : {}),
      });
    });

    this.on("message.status_changed", (e) => {
      this.emitter.emitToTeam(e.teamId, "message:status", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        messageId: e.messageId,
        status: e.status,
      });
    });

    this.on("message.media_ready", (e) => {
      this.emitter.emitToTeam(e.teamId, "message:media:ready", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        messageId: e.messageId,
        ...(e.media ? { media: e.media } : {}),
      });
    });

    this.on("conversation.assigned", (e) => {
      this.emitter.emitToTeam(e.teamId, "conversation:assigned", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        assignedUser: e.assignedUser,
      });
    });

    this.on("conversation.status_changed", (e) => {
      this.emitter.emitToTeam(e.teamId, "conversation:status", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        status: e.newStatus,
      });
    });

    this.on("conversation.deleted", (e) => {
      this.emitter.emitToTeam(e.teamId, "conversation:deleted", {
        teamId: e.teamId,
        conversationId: e.conversationId,
      });
    });

    this.on("conversation.read", (e) => {
      this.emitter.emitToTeam(e.teamId, "conversation:read", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        readByUserId: e.readByUserId,
      });
    });

    this.on("contact.updated", (e) => {
      this.emitter.emitToTeam(e.teamId, "contact:updated", {
        teamId: e.teamId,
        contact: e.contact,
      });
    });

    this.on("contact.deleted", (e) => {
      for (const cid of e.conversationIds) {
        this.emitter.emitToTeam(e.teamId, "conversation:deleted", {
          teamId: e.teamId,
          conversationId: cid,
        });
      }
      this.emitter.emitToTeam(e.teamId, "contact:deleted", {
        teamId: e.teamId,
        contactId: e.contactId,
      });
    });

    this.on("note.created", (e) => {
      this.emitter.emitToTeam(e.teamId, "note:new", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        note: e.note,
      });
    });

    this.on("note.deleted", (e) => {
      this.emitter.emitToTeam(e.teamId, "note:deleted", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        noteId: e.noteId,
      });
    });

    this.on("broadcast.status_changed", (e) => {
      this.emitter.emitToTeam(e.teamId, "broadcast:status", {
        teamId: e.teamId,
        broadcastId: e.broadcastId,
        status: e.status,
        ...(e.error ? { error: e.error } : {}),
      });
    });

    this.on("broadcast.progress", (e) => {
      this.emitter.emitToTeam(e.teamId, "broadcast:progress", {
        teamId: e.teamId,
        broadcastId: e.broadcastId,
        sentCount: e.sentCount,
        failedCount: e.failedCount,
        totalCount: e.totalCount,
      });
    });

    // Broadcast-only mirrors of message.sent / conversation.status_changed.
    // Live on their own types so analytics + audit subscribers stay out (see
    // lib/broadcast-runner.ts head comment for rationale).
    this.on("broadcast.recipient_message_sent", (e) => {
      this.emitter.emitToTeam(e.teamId, "message:new", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        message: e.message,
        preview: e.preview,
        lastMessageAt: e.lastMessageAt,
        unreadDelta: 0,
      });
    });

    this.on("broadcast.conversation_reopened", (e) => {
      this.emitter.emitToTeam(e.teamId, "conversation:status", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        status: "pending",
      });
    });

    // Audit timeline row landed — push to live history-panel viewers.
    this.on("conversation.event_recorded", (e) => {
      this.emitter.emitToTeam(e.teamId, "conversation:event", {
        teamId: e.teamId,
        conversationId: e.conversationId,
        event: e.event,
      });
    });

    // ---- team_channel.* (internal channels) -------------------------------
    this.on("team_channel.message_created", (e) => {
      const threadRootId = e.message.threadRootId;
      this.emitter.emitToTeam(e.teamId, "team:channel:message", {
        teamId: e.teamId,
        channelId: e.channelId,
        message: e.message,
        preview: e.preview,
        lastMessageAt: e.lastMessageAt,
        ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
      });
      if (threadRootId) {
        this.emitter.emitToTeam(e.teamId, "team:channel:thread:reply", {
          teamId: e.teamId,
          channelId: e.channelId,
          rootMessageId: threadRootId,
          replyCount: e.threadReplyCount,
          lastReplyAt: e.message.createdAt,
        });
        this.emitter.emitToChannelThread(threadRootId, "team:channel:message", {
          teamId: e.teamId,
          channelId: e.channelId,
          message: e.message,
          preview: null,
          lastMessageAt: null,
          ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
        });
      }
    });

    this.on("team_channel.message_edited", (e) => {
      this.emitter.emitToTeam(e.teamId, "team:channel:message:edited", {
        teamId: e.teamId,
        channelId: e.channelId,
        messageId: e.messageId,
        body: e.body,
        editedAt: e.editedAt,
      });
    });

    this.on("team_channel.message_deleted", (e) => {
      this.emitter.emitToTeam(e.teamId, "team:channel:message:deleted", {
        teamId: e.teamId,
        channelId: e.channelId,
        messageId: e.messageId,
        threadRootId: e.threadRootId,
      });
    });

    this.on("team_channel.reaction_changed", (e) => {
      this.emitter.emitToTeam(e.teamId, "team:channel:reaction:changed", {
        teamId: e.teamId,
        channelId: e.channelId,
        messageId: e.messageId,
        emoji: e.emoji,
        userIds: e.userIds,
      });
    });

    this.on("team_channel.pin_changed", (e) => {
      this.emitter.emitToTeam(e.teamId, "team:channel:pin:changed", {
        teamId: e.teamId,
        channelId: e.channelId,
        messageId: e.messageId,
        pinned: e.pinned,
      });
    });

    this.on("team_channel.read", (e) => {
      this.emitter.emitToTeam(e.teamId, "team:channel:read", {
        teamId: e.teamId,
        channelId: e.channelId,
        readByUserId: e.readByUserId,
        lastReadAt: e.lastReadAt,
      });
    });

    this.on("team.catalog_changed", (e) => {
      this.emitter.emitToTeam(e.teamId, "team:catalog:changed", {
        teamId: e.teamId,
        scope: e.scope,
      });
    });
  }

  private on<K extends DomainEventType>(
    type: K,
    handler: (e: DomainEventOf<K>) => void | Promise<void>,
  ): void {
    this.bus.subscribe(type, handler, { mode: "any" });
  }
}
