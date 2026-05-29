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
    // Reopen broadcast removed 2026-05-26 — the ingest tx now publishes a
    // dedicated `conversation.status_changed` event for the reopen FIRST,
    // and its own fanout rule (below) emits the same `conversation:status`
    // socket frame. Doing it here too would duplicate the frame AND mean
    // the bus subscribers (audit, analytics, workflow dispatch, outbound
    // webhook) never saw the reopen — the audit timeline missed the pill,
    // `On Conversation opened` workflows silently failed to fire, and
    // partners listening for `conversation.status_changed` got nothing.
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

  // SCOPED TO THE CONVERSATION ROOM, not the team room (realtime audit
  // 2026-05-25, R1). Status ticks (sent → delivered → read) are consumed by
  // exactly ONE client surface — the live thread hook for the conversation the
  // agent is VIEWING (use-conversation-events `onMessageStatus`), which already
  // discards any frame whose conversationId != the displayed thread. The inbox
  // LIST does not consume `message:status` at all. So a team-wide blast made
  // every agent receive + parse a frame they immediately throw away. Each
  // outbound message gets 3 status webhooks (sent/delivered/read); a
  // 1k-recipient broadcast = ~3k frames × every connected tab — the last
  // remaining team-room storm vector after `broadcast.recipient_message_sent`
  // was scoped (see below). Emitting to the conversation room delivers the tick
  // ONLY to agents subscribed to that thread (the common-case empty room is a
  // no-op), with zero behavior change for the viewer.
  "message.status_changed": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "message:status", {
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
  //
  // SCOPED TO THE CONVERSATION ROOM, not the team room (audit 2026-05-22).
  // The normal `message.sent` path fans `message:new` team-wide so every
  // agent's inbox list reorders live — fine at human cadence. A broadcast
  // fires this once PER RECIPIENT (~25/sec, up to 10k), so a team-wide blast
  // is a ~625-frame/sec storm on every connected tab. Emitting to the
  // recipient's conversation room means only an agent actually viewing THAT
  // thread gets the live append (the common-case empty room is a no-op);
  // other agents' list rows refresh on next navigation. Outbound sends don't
  // bump unread, so the only thing skipped team-wide is cosmetic reordering.
  "broadcast.recipient_message_sent": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "message:new", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      message: stripForWire(e.message),
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      unreadCount: e.unreadCount,
    });
  },

  // SCOPED TO THE CONVERSATION ROOM, like its sibling above (realtime audit
  // 2026-05-25, R1). A broadcast can reopen many closed recipients; team-wide
  // `conversation:status` here would fire once PER reopened recipient, each
  // hitting every agent's list `onStatus` (array find + splice + filter-resync)
  // — the same storm `broadcast.recipient_message_sent` was scoped to avoid.
  // We accept the SAME documented tradeoff: an agent watching the "Closed"
  // filter won't see a broadcast-reopened row leave it live; it reconciles on
  // the next filter-resync / navigation. A human viewing THAT thread (in its
  // room) still gets the live flip.
  "broadcast.conversation_reopened": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "conversation:status", {
      teamId: e.teamId,
      conversationId: e.conversationId,
      status: "pending",
    });
  },

  // ---- team_channel.* (internal channels) -------------------------------
  // Channel events fan out to the CHANNEL room, not the team room. Only
  // members of the channel join the room (gateway's subscribe:channel
  // handler enforces `requireChannelMembership`), so non-members never
  // see message bodies, authors, reactions, or pins for channels they
  // were excluded from. members_changed + catalog_changed stay on the
  // team room — they drive the sidebar channel list, which every team
  // member needs to refresh.
  "team_channel.message_created": (e, emitter) => {
    const threadRootId = e.message.threadRootId;
    emitter.emitToChannel(e.channelId, "team:channel:message", {
      teamId: e.teamId,
      channelId: e.channelId,
      message: e.message,
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
    });
    if (threadRootId) {
      emitter.emitToChannel(e.channelId, "team:channel:thread:reply", {
        teamId: e.teamId,
        channelId: e.channelId,
        rootMessageId: threadRootId,
        replyCount: e.threadReplyCount,
        lastReplyAt: e.message.createdAt,
      });
    }
  },

  "team_channel.message_edited": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:message:edited", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      body: e.body,
      editedAt: e.editedAt,
    });
  },

  "team_channel.message_deleted": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:message:deleted", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      threadRootId: e.threadRootId,
    });
  },

  "team_channel.reaction_changed": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:reaction:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      emoji: e.emoji,
      userIds: e.userIds,
      version: e.version,
    });
  },

  "team_channel.pin_changed": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:pin:changed", {
      teamId: e.teamId,
      channelId: e.channelId,
      messageId: e.messageId,
      pinned: e.pinned,
    });
  },

  "team_channel.read": (e, emitter) => {
    // EXCEPTION to the channel-scoped fanout rule: read receipts go to the
    // TEAM room, not the channel room. Two reasons:
    //   (1) Sidebar badge clearing — the team-channels-list hook (which
    //       holds the sidebar's `unreadForMe` per channel) subscribes to
    //       the team room, not per-channel rooms. Scoping reads to the
    //       channel room left the badge stuck in the reader's OTHER tabs
    //       that weren't currently viewing that channel.
    //   (2) Read receipts are PER-USER, not per-message — only the reader's
    //       own tabs filter to them (everyone else's onRead handler bails
    //       on userId mismatch). Putting them on the team room means the
    //       reader's whole device cohort sees the clear; everyone else
    //       gets a single frame they ignore. Net cost is tiny.
    // Messages / edits / deletes / reactions / pins / thread-replies stay
    // channel-scoped — those carry confidential content.
    emitter.emitToTeam(e.teamId, "team:channel:read", {
      teamId: e.teamId,
      channelId: e.channelId,
      readByUserId: e.readByUserId,
      lastReadAt: e.lastReadAt,
    });
  },

  "team_channel.thread_reply_count_changed": (e, emitter) => {
    // Reuses the existing socket frame the create-reply rule emits — clients
    // already handle it as a counter+lastReplyAt update on the parent pill.
    emitter.emitToChannel(e.channelId, "team:channel:thread:reply", {
      teamId: e.teamId,
      channelId: e.channelId,
      rootMessageId: e.rootMessageId,
      replyCount: e.replyCount,
      lastReplyAt: e.lastReplyAt,
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

  "user.availability_changed": (e, emitter) => {
    // Per-user badge update — teammates' sidebar dots + user-menu reflect the
    // new status in the same frame.
    emitter.emitToTeam(e.teamId, "user:availability:updated", {
      teamId: e.teamId,
      userId: e.userId,
      status: e.status as
        | "available"
        | "busy"
        | "away"
        | "offline",
      ...(e.message !== undefined ? { message: e.message } : {}),
    });
    // "Appear offline" (or coming OUT of it) shifts the visibly-online set, so
    // re-emit a fresh presence snapshot to the team. Cheaper than tracking the
    // prior status — the snapshot read is one in-memory map walk and a
    // presence:update is small. Other status changes don't move the set, so
    // skip the extra emit there.
    if (e.status === "offline" || e.status === "available") {
      emitter.emitPresenceSnapshot(e.teamId);
    }
    // "Also viewing" pills are gated on `availabilityStatus === "available"`.
    // ANY status change can shift the set (available ↔ busy / away / offline),
    // so re-emit `conversation:viewers` for every conversation this user is
    // currently viewing — teammates' pills add/drop them in the same frame
    // as the badge. No-op (early-returns) when the user isn't viewing
    // anything, so the cost is one in-memory walk for the common case.
    void emitter.emitConversationViewersForUser(e.userId);
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

  // Org name was changed by an admin. Sidebar chrome + settings header
  // listen and patch the displayed name in place — no router.refresh().
  "team.renamed": (e, emitter) => {
    emitter.emitToTeam(e.teamId, "team:renamed", {
      teamId: e.teamId,
      name: e.name,
      renamedByUserId: e.renamedByUserId,
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
