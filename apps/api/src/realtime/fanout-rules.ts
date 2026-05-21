import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";
import type { Message } from "@ccp/shared/types";

import type { RealtimeEmitter } from "./emitter.service";

/**
 * Strip the rawPayload column before emitting a Message over the wire. Today
 * every publish path already builds events without rawPayload (inbound:
 * ingest.ts:466 comment; outbound: only a tiny `{ sentVia }` tag), but this
 * fence prevents a future caller from accidentally fanning out 2-8 KB of raw
 * Meta payload to every connected agent. Cost: one shallow spread per emit.
 */
function stripForWire(m: Message): Message {
  if (!("rawPayload" in m) || m.rawPayload === undefined) return m;
  const { rawPayload: _drop, ...rest } = m;
  return rest;
}

/**
 * Bus → wire-emit table. Single source of truth for "which domain event
 * fans out as which Socket.io event, with what payload."
 *
 * Shape: a Record keyed by every member of `DomainEventType`. Adding a new
 * event to `DomainEventMap` becomes a compile error here until the author
 * either writes a handler OR explicitly opts out with `null`. Without this
 * shape, a forgotten event silently vanishes from the wire with zero
 * warning — the failure mode the bulk-update audit caught.
 *
 * Handlers preserve per-event payload typing: each value is `Handler<K>`
 * for its own key K, so field renames break the build at the emit-site.
 *
 * `null` is the intentional "no socket frame" marker. The three
 * `contact.*_changed` narrow events use it because every publisher of
 * those also publishes a `contact.updated` carrying the hydrated row, so
 * a duplicate socket frame would just double the reducer cost. The narrow
 * events still drive outbound-webhook routing.
 */

type Handler<K extends DomainEventType> = (
  event: DomainEventOf<K>,
  emitter: RealtimeEmitter,
) => void | Promise<void>;

export type FanoutRuleMap = {
  [K in DomainEventType]: Handler<K> | null;
};

export const FANOUT_RULES: FanoutRuleMap = {
  // ---- messages ---------------------------------------------------------
  "message.received": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: stripForWire(e.message),
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadCount: e.unreadCount,
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
  },

  "message.sent": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: stripForWire(e.message),
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadCount: e.unreadCount,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
      ...(e.newConversation ? { newConversation: e.newConversation } : {}),
    });
  },

  "message.status_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      status: e.status,
    });
  },

  // Background send worker failed. Emit team-wide (same shape as message:new
  // for cache-eviction symmetry): the inbox shell evicts the conv's cached
  // snapshot if it's not the displayed thread, and the active thread's
  // useConversationEvents hook applies markOptimisticFailed by clientTempId.
  "message.send_failed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:failed", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
      reason: e.reason,
      ...(e.detail ? { detail: e.detail } : {}),
    });
  },

  "message.media_ready": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:media:ready", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      ...(e.media ? { media: e.media } : {}),
    });
  },

  // ---- conversations ----------------------------------------------------
  "conversation.assigned": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:assigned", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      assignedUser: e.assignedUser,
    });
  },

  "conversation.status_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      status: e.newStatus,
    });
  },

  "conversation.deleted": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:deleted", {
      teamId: e.teamId,
      conversationId: e.conversationId,
    });
  },

  "conversation.read": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:read", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      readByUserId: e.readByUserId,
    });
  },

  // ---- contacts ---------------------------------------------------------
  "contact.updated": (e, emitter) => {
    // Bulk paths suppress the per-contact frame and rely on the coalesced
    // `contact.bulk_updated` rule below. Workflow + audit subscribers still
    // see the per-contact event for granular dispatch (they don't read this
    // flag) — only socket fanout is short-circuited.
    if (e.suppressSocketFanout) return;
    emitter.emitToTeam(e.teamId, "contact:updated", {
      teamId: e.teamId,
      contact: e.contact,
    });
  },

  // A brand-new contact landed (manual create, /v1 API, CSV import, or the
  // inbound-message path's first-touch). Inbound-message paths get an
  // additional `message.received` carrying `newConversation` for the inbox
  // splice — this rule covers the contact-only creation paths where no
  // message is involved. Emits the SAME wire event as `contact.updated`
  // because the frontend reconciler already inserts a row into the contacts
  // list when an unfamiliar id arrives that matches the active filter
  // (contact-browser.tsx:reconcileContactUpdate). Re-using the wire frame
  // means no new client handler is needed for the same UX outcome.
  "contact.created": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "contact:updated", {
      teamId: e.teamId,
      contact: e.contact,
    });
  },

  // Narrow events used ONLY for outbound-webhook routing (so partners can
  // subscribe to "On Tag updated" / "On Lifecycle updated" without seeing
  // every field-edit). Every publisher of one of these also publishes a
  // `contact.updated` carrying the hydrated row — that handler above
  // already covers the socket fanout. Adding a duplicate frame here would
  // just double the reducer cost on the frontend.
  "contact.tag_changed": null,
  "contact.lifecycle_changed": null,

  // One socket frame for an N-contact bulk mutation. Frontend invalidates
  // the affected rows in one query rather than receiving N patches.
  "contact.bulk_updated": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "contacts:bulk_updated", {
      teamId: e.teamId,
      contactIds: e.contactIds,
      changeKind: e.changeKind,
    });
  },

  "contact.deleted": (e, emitter) => {
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
  },

  // ---- notes ------------------------------------------------------------
  "note.created": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "note:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      note: e.note,
    });
  },

  "note.deleted": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "note:deleted", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      noteId: e.noteId,
    });
  },

  // ---- broadcasts -------------------------------------------------------
  "broadcast.status_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "broadcast:status", {
      teamId: e.teamId,
      broadcastId: e.broadcastId,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    });
  },

  "broadcast.progress": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "broadcast:progress", {
      teamId: e.teamId,
      broadcastId: e.broadcastId,
      sentCount: e.sentCount,
      failedCount: e.failedCount,
      totalCount: e.totalCount,
    });
  },

  // Broadcast-only mirrors of message.sent / conversation.status_changed.
  // Live on their own types so analytics + audit subscribers stay out (see
  // lib/broadcast-runner.ts head comment for rationale).
  "broadcast.recipient_message_sent": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: stripForWire(e.message),
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadCount: e.unreadCount,
    });
  },

  "broadcast.conversation_reopened": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "conversation:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      status: "pending",
    });
  },

  // ---- team_channel.* (internal channels) -------------------------------
  "team_channel.message_created": (e, emitter) => {
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
      // Thread-room emit of `team:channel:message` would duplicate the
      // team-room emit above (every socket is auto-joined to the team
      // room). Only the thread-summary signal goes to the thread room.
      emitter.emitToTeam(e.teamId, "team:channel:thread:reply", {
        teamId: e.teamId,
        channelId: e.channelId,
        rootMessageId: threadRootId,
        replyCount: e.threadReplyCount,
        lastReplyAt: e.message.createdAt,
      });
    }
  },

  "team_channel.message_edited": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:message:edited", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      body: e.body,
      editedAt: e.editedAt,
    });
  },

  "team_channel.message_deleted": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:message:deleted", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      threadRootId: e.threadRootId,
    });
  },

  "team_channel.reaction_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:reaction:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      emoji: e.emoji,
      userIds: e.userIds,
      version: e.version,
    });
  },

  "team_channel.pin_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:pin:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      pinned: e.pinned,
    });
  },

  "team_channel.read": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:read", {
      teamId: e.teamId,
      channelId: e.channelId,
      readByUserId: e.readByUserId,
      lastReadAt: e.lastReadAt,
    });
  },

  "team_channel.members_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:channel:members:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      action: e.action,
      userIds: e.userIds,
      changedById: e.changedById,
    });
    // Catalog tick so the channel list (memberCount, visibility) refreshes
    // for everyone — including the just-added users who need to start seeing
    // this channel and the just-removed users who need to stop seeing it.
    emitter.emitToTeam(e.teamId, "team:catalog:changed", {
      teamId: e.teamId,
      scope: "team-channels",
    });
  },

  "user.profile_updated": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "user:profile:updated", {
      teamId: e.teamId,
      userId: e.userId,
      ...(e.name !== undefined ? { name: e.name } : {}),
      ...(e.avatarUrl !== undefined ? { avatarUrl: e.avatarUrl } : {}),
    });
    // Members list (assignment dropdown, contact-panel "assigned to", etc.)
    // refetches against this scope.
    emitter.emitToTeam(e.teamId, "team:catalog:changed", {
      teamId: e.teamId,
      scope: "members",
    });
  },

  // ---- team-wide --------------------------------------------------------
  "team.catalog_changed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:catalog:changed", {
      teamId: e.teamId,
      scope: e.scope,
    });
  },

  // Outbound-webhook circuit breaker tripped → toast the settings page so an
  // admin watching the integrations panel sees the failure in real time.
  "webhook.subscription_disabled": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "webhook:subscription_disabled", {
      teamId: e.teamId,
      webhookId: e.webhookId,
      reason: e.reason,
    });
  },

  // Counterpart: a previously-failing webhook recovered. UI clears the
  // unhealthy badge so the operator doesn't have to refresh manually.
  "webhook.subscription_recovered": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "webhook:subscription_recovered", {
      teamId: e.teamId,
      webhookId: e.webhookId,
    });
  },
};
