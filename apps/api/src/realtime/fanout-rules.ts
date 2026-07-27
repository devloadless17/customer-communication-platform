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
 *
 * Room-scoping rules — DO NOT REGRESS (this is the "two tabs disagree" /
 * "broadcast storm" decision-tree class):
 *
 *   - emitToWorkspace        → use when EVERY agent on the team needs to know.
 *                          Examples: message:new (list ordering), conversation
 *                          status / assigned / read (badges), contact:updated
 *                          (panel + filter pruning), team-wide presence.
 *   - emitToConversation → use when only viewers OF this thread care.
 *                          Examples: message:status, message:media:ready,
 *                          typing:update, conversation:viewers, broadcast
 *                          recipient frames (storm prevention — a 10k-recipient
 *                          broadcast must NOT fan team-wide).
 *   - emitToChannel     → team-chat channel-scoped (membership-gated, default
 *                          channel auto-passes); never use for customer convos.
 *
 *   If you can't articulate "every team member needs this NOW", default to
 *   the narrower scope. A bug where someone misses a frame they wanted is
 *   recoverable (next mutation or visibility-resync surfaces it). A bug
 *   where 10k frames fan out per second to every tab is not.
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
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:new", {
      workspaceId: e.workspaceId,
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
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:new", {
      workspaceId: e.workspaceId,
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
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      status: e.status,
      // Forward the provider failure reason to the viewing agent's failed
      // bubble. Only on a `failed` transition that carried a Meta `errors[0]`
      // (same conditional the ingest mapper uses to stamp the event); absent
      // on every sent/delivered/read tick.
      ...(e.status === "failed" && e.errorCode !== undefined
        ? { errorCode: e.errorCode }
        : {}),
      ...(e.status === "failed" && e.errorTitle !== undefined
        ? { errorTitle: e.errorTitle }
        : {}),
      ...(e.status === "failed" && e.errorDetail !== undefined
        ? { errorDetail: e.errorDetail }
        : {}),
    });
  },

  // Reaction set / changed / removed (customer OR our own agent side — `actor`
  // discriminates). TEAM-room scoped, same reasoning as message.updated and
  // media_ready: `message:reaction` is in THREAD_REDUCER_EVENTS, so the inbox
  // shell's LRU ThreadCache patches its CACHED snapshots from it
  // (applyMessageReaction) — and a cached background thread's socket never
  // joined `conv:<id>`, so a conversation-room frame silently skipped it,
  // leaving a stale/missing reaction badge on switch-back until a hard reload.
  // Reactions are human-cadence (one frame per emoji tap) so a small team frame
  // carries no storm risk, and a persistent removable badge is worth converging
  // all three thread consumers (CLAUDE.md §10). `emoji` is null on removal.
  "message.reaction_changed": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:reaction", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      actor: e.actor,
      emoji: e.emoji,
    });
  },

  // A triage flag was raised / changed / resolved / removed on a message.
  // TEAM-room scoped for the same reason as message.reaction_changed —
  // `message:flag` is in THREAD_REDUCER_EVENTS, so the inbox shell's LRU
  // ThreadCache patches CACHED background snapshots from it, and those threads'
  // sockets never joined `conv:<id>`. It ALSO feeds two surfaces that live
  // outside any conversation room: the flags queue page and the inbox list's
  // flag badge. Human-cadence (one frame per triage action), so the team frame
  // carries no storm risk.
  //
  // `flag` is the post-change state and is present even on `removed` (the
  // reducer matches on `flag.id`); `openFlagCount` is the parent conversation's
  // post-change count, read inside the same transaction, so the list badge is
  // exact without a follow-up query.
  // Ticket board + inbox badge. WORKSPACE-scoped on purpose — see the
  // `ticket:changed` contract comment: the board is a workspace-wide view of
  // work across threads whose conversation rooms nobody has joined.
  "ticket.changed": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "ticket:changed", {
      workspaceId: e.workspaceId,
      ticketId: e.ticketId,
      conversationId: e.conversationId,
      action: e.action,
      ticket: e.ticket,
      previousStatus: e.previousStatus,
      ...(e.breachedLeg ? { breachedLeg: e.breachedLeg } : {}),
      openTicketCount: e.openTicketCount,
    });
  },

  "message.flag_changed": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:flag", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      action: e.action,
      flag: e.flag,
      openFlagCount: e.openFlagCount,
    });
  },

  // Customer unsent / edited a message. TEAM-room scoped, unlike reactions and
  // status ticks: `message:updated` is in THREAD_REDUCER_EVENTS, so the inbox
  // shell's LRU ThreadCache patches its CACHED snapshots from it — and a cached
  // background thread's socket never joined `conv:<id>`, so a conversation-room
  // frame silently skipped it. The agent would then open that thread and see the
  // original text of a message the list already showed as deleted. Corrections
  // (customer unsend/edit) are rare, so one small team frame is the right cost
  // for making all three thread consumers converge (CLAUDE.md §10).
  //
  // When the correction hit the thread's NEWEST message the denormalized list
  // preview also changed: the event carries `listPreview`, and we push a second
  // team frame (`conversation:preview`) that the inbox LIST consumes — the list
  // doesn't read thread events, and thread consumers don't read the preview.
  "message.updated": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:updated", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      deletedAt: e.deletedAt,
      editedAt: e.editedAt,
      body: e.body,
      ...(e.feedback !== undefined ? { feedback: e.feedback } : {}),
    });
    if (e.listPreview !== undefined) {
      emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "conversation:preview", {
        workspaceId: e.workspaceId,
        conversationId: e.conversationId,
        preview: e.listPreview,
        lastMessageAt: e.listPreviewAt ?? null,
      });
    }
  },

  // Background send worker failed. Emit team-wide (same shape as message:new
  // for cache-eviction symmetry): the inbox shell evicts the conv's cached
  // snapshot if it's not the displayed thread, and the active thread's
  // useConversationEvents hook applies markOptimisticFailed by clientTempId.
  "message.send_failed": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:failed", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
      reason: e.reason,
      ...(e.detail ? { detail: e.detail } : {}),
    });
  },

  // TEAM ROOM (was conversation-scoped). A thread's cached LRU snapshot also
  // needs the hydrated-media patch, not just the live-displayed thread: an
  // agent who sends a video (or whose customer sends media) and switches chats
  // before the ~1-2s download/poster completes left the conversation room — a
  // conversation-scoped frame would never reach their cached snapshot, so on
  // switch-back the bubble was a bare black/shimmer box until a hard reload.
  // The inbox-shell `media:ready` reducer (thread-reducers.ts) patches the LRU
  // cache off the team room. Unlike the status-tick storm this was once scoped
  // against (3 frames/message, every message), media_ready is ~1 frame per
  // MEDIA message — well within the same budget as `message:new` (also team-
  // wide); a non-caching recipient drops it with one cheap find-by-id miss.
  "message.media_ready": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "message:media:ready", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      ...(e.media ? { media: e.media } : {}),
    });
  },

  // ---- conversations ----------------------------------------------------
  "conversation.assigned": (e, emitter) => {
    // The assignee just changed — drop the emitter's cached owner so the NEXT
    // frame targets the new one immediately instead of up to a TTL later.
    // Without this, a reassigned conversation's messages would keep flowing to
    // the PREVIOUS owner's room for up to 30 seconds.
    emitter.invalidateConversationAssignee(e.conversationId);
    // ...and revoke the conv-room membership visibility granted the previous
    // assignee: subscribe-time checks alone never expire, so a restricted
    // agent who lost the thread kept listening in its room indefinitely.
    emitter.evictStaleFromConversationRoom(
      e.workspaceId,
      e.conversationId,
      e.assignedUser?.id ?? null,
    );
    // Target the PREVIOUS owner explicitly as well. Under visibility scoping
    // the audience is resolved from the CURRENT assignee, so without this the
    // agent who just lost the conversation never hears about it and keeps a row
    // in their inbox that 404s when clicked.
    emitter.emitAboutConversationAlso(e.workspaceId,
      e.conversationId, [e.previousAssignedUserId], "conversation:assigned", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      assignedUser: e.assignedUser,
    });
  },

  "conversation.status_changed": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "conversation:status", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      status: e.newStatus,
    });
  },

  "conversation.ai_changed": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "conversation:ai", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      aiEnabled: e.newAiEnabled,
    });
  },

  "conversation.deleted": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "conversation:deleted", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
    });
  },

  "conversation.read": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "conversation:read", {
      workspaceId: e.workspaceId,
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
    emitter.emitAboutContact(e.workspaceId, e.contact?.id, "contact:updated", {
      workspaceId: e.workspaceId,
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
    // CSV import publishes a per-row `contact.created` with
    // `suppressSocketFanout: true` and relies on the coalesced
    // `contact.bulk_updated` rule below for the single socket frame —
    // mirroring how `contact.updated` honors the same flag. Webhook + audit
    // + workflow subscribers still see the per-row created event (they don't
    // read this flag); only socket fanout is short-circuited, so a 500-row
    // import doesn't storm every connected tab with 500 `contact:updated`
    // frames.
    if (e.suppressSocketFanout) return;
    emitter.emitAboutContact(e.workspaceId, e.contact?.id, "contact:updated", {
      workspaceId: e.workspaceId,
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
    emitter.emitToWorkspace(e.workspaceId, "contacts:bulk_updated", {
      workspaceId: e.workspaceId,
      contactIds: e.contactIds,
      changeKind: e.changeKind,
    });
  },

  // Import/export progress → the INITIATOR only. A team-wide frame every 2s
  // for the duration of someone else's export is pure noise on every open tab,
  // and fanout scope in this app is a deliberate choice, not a default
  // (CLAUDE.md §10). Note there is no audit/analytics/workflow/webhook
  // subscriber for this event — see the type's docblock.
  "contact.transfer_updated": (e, emitter) => {
    emitter.emitToUser(e.workspaceId, e.userId, "contacts:transfer_progress", {
      workspaceId: e.workspaceId,
      job: e.job,
    });
  },

  "contact.deleted": (e, emitter) => {
    for (const cid of e.conversationIds) {
      emitter.emitAboutConversation(e.workspaceId,
          cid, "conversation:deleted", {
        workspaceId: e.workspaceId,
        conversationId: cid,
      });
    }
    emitter.emitAboutContact(e.workspaceId, e.contactId, "contact:deleted", {
      workspaceId: e.workspaceId,
      contactId: e.contactId,
    });
  },

  // ---- notes ------------------------------------------------------------
  "note.created": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "note:new", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      note: e.note,
    });
  },

  "note.deleted": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "note:deleted", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      noteId: e.noteId,
    });
  },

  // ---- broadcasts -------------------------------------------------------
  "broadcast.status_changed": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "broadcast:status", {
      workspaceId: e.workspaceId,
      broadcastId: e.broadcastId,
      status: e.status,
      ...(e.error ? { error: e.error } : {}),
    });
  },

  "broadcast.progress": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "broadcast:progress", {
      workspaceId: e.workspaceId,
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
      workspaceId: e.workspaceId,
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
      workspaceId: e.workspaceId,
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
  "team_channel.message_created": async (e, emitter) => {
    const threadRootId = e.message.threadRootId;
    emitter.emitToChannel(e.channelId, "team:channel:message", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      message: e.message,
      preview: e.preview,
      lastMessageAt: e.lastMessageAt,
      ...(e.clientTempId ? { clientTempId: e.clientTempId } : {}),
    });
    // Content-lean SIDEBAR badge companion (unread dot + mention counter) for
    // members NOT currently subscribed to this channel's room. The channel-room
    // frame above only reaches a tab that has the channel open, so without this
    // a member posting in another channel produced zero sidebar dot until
    // reconnect/reload. RT-1: routed through `emitChannelActivity`, which sends
    // it to the WHOLE TEAM only for the default channel; for a membership-gated
    // channel it goes ONLY to the members' per-user rooms — so a non-member
    // never receives a private channel's activity metadata (author, mentions,
    // even the channelId) on the wire. Carries no body/preview regardless.
    // Skip on a dedup re-publish (retry): the original send already badged
    // everyone, so re-badging would resurrect a stuck unread dot for members
    // who have since read the message. message:new / thread frames still fire.
    if (e.redelivery !== true) {
      await emitter.emitChannelActivity(e.channelId, e.workspaceId, {
        workspaceId: e.workspaceId,
        channelId: e.channelId,
        authorUserId: e.message.authorUserId,
        mentionedUserIds: e.message.mentionedUserIds,
        lastMessageAt: e.lastMessageAt,
        isReply: threadRootId !== null,
      });
    }
    if (threadRootId) {
      emitter.emitToChannel(e.channelId, "team:channel:thread:reply", {
        workspaceId: e.workspaceId,
        channelId: e.channelId,
        rootMessageId: threadRootId,
        replyCount: e.threadReplyCount,
        lastReplyAt: e.message.createdAt,
      });
    }
  },

  "team_channel.message_edited": async (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:message:edited", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      messageId: e.messageId,
      body: e.body,
      editedAt: e.editedAt,
    });
    // An edit that ADDED an @-mention has to reach the newly-mentioned people
    // the same way a new message would — the channel-room frame above only
    // lands in a tab that already has this channel open. Scoped to the ADDED
    // ids: badging every prior mention again on a typo fix would un-read
    // mentions people had already cleared.
    const newly = e.newlyMentionedUserIds ?? [];
    if (newly.length > 0) {
      await emitter.emitChannelActivity(e.channelId, e.workspaceId, {
        workspaceId: e.workspaceId,
        channelId: e.channelId,
        authorUserId: e.authorUserId ?? null,
        mentionedUserIds: newly,
        // Nothing moved in the channel ordering — no new message was posted.
        lastMessageAt: null,
        // `isReply` is the client's "mention-only, don't bump the unread dot"
        // flag (use-team-channels-events.ts). An edit wants exactly that
        // behaviour: badge the mention, leave the unread dot alone.
        isReply: true,
      });
    }
  },

  "team_channel.message_deleted": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:message:deleted", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      messageId: e.messageId,
      threadRootId: e.threadRootId,
    });
  },

  "team_channel.reaction_changed": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:reaction:changed", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      messageId: e.messageId,
      emoji: e.emoji,
      userIds: e.userIds,
      version: e.version,
    });
  },

  "team_channel.pin_changed": (e, emitter) => {
    emitter.emitToChannel(e.channelId, "team:channel:pin:changed", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      messageId: e.messageId,
      pinned: e.pinned,
      // Carried so the pins bar updates from the message the client already
      // holds instead of refetching the whole list on every pin.
      pinnedAt: e.pinnedAt,
      pinnedById: e.pinnedById,
      pinnedByName: e.pinnedByName,
    });
  },

  "team_channel.read": async (e, emitter) => {
    // Read receipts must reach the reader's OTHER tabs to clear the sidebar
    // badge (the team-channels-list hook holds `unreadForMe` per channel). They
    // are PER-USER — everyone else's onRead handler bails on a userId mismatch.
    //
    // minor#10: route like RT-1 instead of an unconditional team-wide blast. For
    // the DEFAULT channel (everyone is a member) → team room (cheap, no leak).
    // For a membership-gated channel → ONLY the members' per-user rooms, so a
    // non-member never receives the private channel's id / reader id / timestamp
    // on the wire (the exact metadata-on-the-wire leak RT-1 was built to close).
    // The reader is a member (they just read it) and joins their own user-room,
    // so their whole device cohort still gets the badge-clear.
    // Messages / edits / deletes / reactions / pins / thread-replies stay
    // channel-scoped — those carry confidential content.
    await emitter.emitChannelScoped(e.channelId, e.workspaceId, "team:channel:read", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      readByUserId: e.readByUserId,
      lastReadAt: e.lastReadAt,
    });
  },

  "team_channel.thread_reply_count_changed": (e, emitter) => {
    // Reuses the existing socket frame the create-reply rule emits — clients
    // already handle it as a counter+lastReplyAt update on the parent pill.
    emitter.emitToChannel(e.channelId, "team:channel:thread:reply", {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      rootMessageId: e.rootMessageId,
      replyCount: e.replyCount,
      lastReplyAt: e.lastReplyAt,
    });
  },

  "team_channel.members_changed": async (e, emitter) => {
    // minor#10 / RT-1: never blast private-channel roster metadata (channelId,
    // added/removed userIds, actor) to the whole team room — that's the exact
    // metadata-on-the-wire leak RT-1 closed for activity/read frames. Route the
    // frame membership-scoped (default channel → team-wide, since everyone's a
    // member anyway; gated channel → members only). A REMOVED user is no longer
    // a member at emit time, so emitChannelScoped won't reach them — address
    // their user room directly so they still get the immediate prune frame.
    const payload = {
      workspaceId: e.workspaceId,
      channelId: e.channelId,
      action: e.action,
      userIds: e.userIds,
      changedById: e.changedById,
    };
    await emitter.emitChannelScoped(
      e.channelId,
      e.workspaceId,
      "team:channel:members:changed",
      payload,
    );
    if (e.action === "removed") {
      for (const uid of e.userIds) {
        emitter.emitToUser(e.workspaceId, uid, "team:channel:members:changed", payload);
      }
    }
    // Catalog tick so the channel list (memberCount, visibility) refreshes
    // for everyone — including the just-added users who need to start seeing
    // this channel and the just-removed users who need to stop seeing it.
    emitter.emitToWorkspace(e.workspaceId, "team:catalog:changed", {
      workspaceId: e.workspaceId,
      scope: "team-channels",
    });
  },

  "team_channel.dm_created": (e, emitter) => {
    // ONLY the participants' user rooms — never the team room. The existence
    // of a DM between two people is itself private information.
    //
    // Chosen over a team.catalog_changed tick because that would make every
    // member of the team refetch whenever any two people start a DM; here the
    // audience is exactly known, so we address it directly.
    for (const uid of e.memberUserIds) {
      emitter.emitToUser(e.workspaceId, uid, "team:dm:created", {
        workspaceId: e.workspaceId,
        channelId: e.channelId,
        createdByUserId: e.createdByUserId,
      });
    }
  },

  "user.availability_changed": (e, emitter) => {
    // Per-user badge update — teammates' sidebar dots + user-menu reflect the
    // new status in the same frame.
    emitter.emitToWorkspace(e.workspaceId, "user:availability:updated", {
      workspaceId: e.workspaceId,
      userId: e.userId,
      status: e.status as
        | "available"
        | "busy"
        | "away"
        | "offline",
      ...(e.message !== undefined ? { message: e.message } : {}),
      // Provenance ("who set this") + when a manual pick hands back to the
      // schedule. Teammates render the first; the user's own picker renders
      // both, plus `manual` so their note box shows what THEY typed rather
      // than the schedule's "Outside working hours" text.
      ...(e.source !== undefined
        ? { source: e.source as "manual" | "admin" | "schedule" }
        : {}),
    });
    // `manual` (what the user typed) and `until` (when their override lapses)
    // go ONLY to the user's own room, never to the team.
    //
    // The whole point of the schedule is that it MASKS the personal note:
    // teammates should see "Outside working hours · back Mon 09:00", not
    // "Doctor's appointment — back later". Putting `manual` on the team frame
    // shipped the private text to every teammate's socket, with nothing but a
    // client-side `if (userId !== me) return` keeping it off screen — it was
    // still on the wire and readable in any teammate's devtools.
    if (e.manual !== undefined || e.until !== undefined) {
      emitter.emitToUser(e.workspaceId, e.userId, "user:availability:updated", {
        workspaceId: e.workspaceId,
        userId: e.userId,
        status: e.status as "available" | "busy" | "away" | "offline",
        ...(e.message !== undefined ? { message: e.message } : {}),
        ...(e.source !== undefined
          ? { source: e.source as "manual" | "admin" | "schedule" }
          : {}),
        ...(e.until !== undefined ? { until: e.until } : {}),
        ...(e.manual !== undefined
          ? {
              manual: {
                status: e.manual.status as "available" | "busy" | "away" | "offline",
                message: e.manual.message,
              },
            }
          : {}),
      });
    }
    // Toggling "Appear offline" — in EITHER direction, including offline→busy /
    // offline→away — shifts the visibly-online set (the snapshot filters only
    // status === "offline"), so re-emit a fresh presence snapshot to the team.
    // The event carries no previous status, so we can't tell whether this change
    // crossed the offline boundary; just re-emit on every availability change.
    // It's rare (a manual picker click) and cheap — the snapshot read is one
    // in-memory map walk and a presence:update is small.
    emitter.emitPresenceSnapshot(e.workspaceId);
    // "Also viewing" pills are gated on `availabilityStatus === "available"`.
    // ANY status change can shift the set (available ↔ busy / away / offline),
    // so re-emit `conversation:viewers` for every conversation this user is
    // currently viewing — teammates' pills add/drop them in the same frame
    // as the badge. No-op (early-returns) when the user isn't viewing
    // anything, so the cost is one in-memory walk for the common case.
    void emitter.emitConversationViewersForUser(e.userId);
  },

  "user.profile_updated": (e, emitter) => {
    // The dedicated `user:profile:updated` frame was dropped — it broadcast to
    // every team member on every profile edit with ZERO client subscribers.
    // The members list (assignment dropdown, contact-panel "assigned to", etc.)
    // already refreshes off this `team:catalog:changed { scope: members }`
    // frame, which IS consumed — so a name/avatar change still propagates.
    emitter.emitToWorkspace(e.workspaceId, "team:catalog:changed", {
      workspaceId: e.workspaceId,
      scope: "members",
    });
  },

  // ---- team-wide --------------------------------------------------------
  "team.catalog_changed": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "team:catalog:changed", {
      workspaceId: e.workspaceId,
      scope: e.scope,
    });
  },

  // Org name was changed by an admin. Sidebar chrome + settings header
  // listen and patch the displayed name in place — no router.refresh().
  "team.renamed": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "team:renamed", {
      workspaceId: e.workspaceId,
      name: e.name,
      renamedByUserId: e.renamedByUserId,
    });
  },

  // Outbound-webhook circuit breaker tripped → toast the settings page so an
  // admin watching the integrations panel sees the failure in real time.
  "webhook.subscription_disabled": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "webhook:subscription_disabled", {
      workspaceId: e.workspaceId,
      webhookId: e.webhookId,
      reason: e.reason,
    });
  },

  // Counterpart: a previously-failing webhook recovered. UI clears the
  // unhealthy badge so the operator doesn't have to refresh manually.
  "webhook.subscription_recovered": (e, emitter) => {
    emitter.emitToWorkspace(e.workspaceId, "webhook:subscription_recovered", {
      workspaceId: e.workspaceId,
      webhookId: e.webhookId,
    });
  },

  // ---- Native AI Assistant (conversation-room scoped) --------------------
  // Panel/suggestion-level signals; the inbox AI surfaces refetch on receipt.
  "ai.suggestion_changed": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "ai:suggestion", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      suggestionId: e.suggestionId,
      state: e.state,
    });
  },
  "ai.summary_changed": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "ai:summary", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
    });
  },
  "ai.memory_changed": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "ai:memory", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      customerId: e.customerId,
    });
  },
  "ai.state_changed": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "ai:state", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      state: e.state,
    });
  },
  "ai.transcription_changed": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "ai:transcription", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      status: e.status,
    });
  },
  "ai.message_flagged": (e, emitter) => {
    emitter.emitToConversation(e.conversationId, "ai:flag", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      messageId: e.messageId,
      risk: e.risk,
      notes: e.notes,
    });
  },

  // ---- WhatsApp Business Calling -----------------------------------------
  // Room-scoping rules per call phase (mirrors the locked availability:*
  // split decision — each phase rides its own frame for narrowest payload).
  //
  //   call.incoming           → TEAM room. Any agent might pick up; toast all.
  //   call.ringing_out        → TEAM room. The thread banner only paints for the
  //                              agent viewing that thread (the inbox reducer
  //                              filters `call:ringing` by conversationId), but
  //                              the team-wide "Calls" badge counts ringing rows
  //                              (calls.service.liveCount) and refetches off this
  //                              frame, so a conversation-scoped emit left every
  //                              non-viewer's badge blind to the whole outbound
  //                              ring phase until call:answered/ended ticked.
  //   call.answered_by_agent  → TEAM room. Dismisses incoming toast on every
  //                              OTHER browser. The winning agent's local
  //                              optimistic dispatch already flipped its UI.
  //   call.ended / missed /   → TEAM room. Updates the inbox list "ongoing
  //     rejected / failed       call" badge + thread timeline pill across all
  //                              agents who might have the thread cached.
  //   call.sdp_offer          → TEAM room. The answering agent's browser
  //                              filters by callId; broadcasting it widely
  //                              avoids the "agent A clicked answer but the
  //                              SDP only went to agent B" race.
  "call.incoming": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:incoming", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      externalCallId: e.externalCallId,
      channel: e.channel,
      contactId: e.contact.id,
      contactName: e.contact.name,
      ringingAt: e.ringingAt,
    });
  },

  "call.ringing_out": (e, emitter) => {
    // TEAM room, not conversation room (audit 2026-06-11): the inbox thread
    // reducer filters `call:ringing` by `conversationId` so only the agent
    // viewing the originating thread paints the ring banner — identical to the
    // old conversation-scoped behavior — but the team-wide Calls badge counts
    // ringing rows and refetches off this frame, so non-viewers must receive it
    // or their badge undercounts every outbound call's ring phase (≤60s) until
    // call:answered / call:ended fires. Payload is tiny; the team-wide fan is
    // a single frame per call, not a per-recipient storm.
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:ringing", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      initiatedByUserId: e.initiatedByUserId,
      ringingAt: e.ringingAt,
    });
  },

  "call.answered_by_agent": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:answered", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      answeredByUserId: e.answeredByUserId,
      answeredAt: e.answeredAt,
    });
  },

  "call.ended": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:ended", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      durationSeconds: e.durationSeconds,
      endedAt: e.endedAt,
      status: "completed",
    });
  },

  "call.missed": (e, emitter) => {
    // Same wire frame as call:ended — status discriminates the bubble copy.
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:ended", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      durationSeconds: null,
      endedAt: e.ringingAt,
      status: "missed",
    });
  },

  "call.rejected": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:ended", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      durationSeconds: null,
      // Real decline time off the event, not a fanout-synthesized `new Date()`.
      endedAt: e.endedAt,
      status: "rejected",
    });
  },

  "call.failed": (e, emitter) => {
    // TEAM-room, matching every sibling terminal phase (call.ended/missed/
    // rejected above). A failed call must dismiss the team-wide incoming-call
    // toast + tear down the live call for the SAME population that received
    // call:incoming — agents who saw the toast but aren't viewing the thread
    // are NOT in the conversation room, so a conversation-scoped frame would
    // leave them with a stuck phantom "Customer is calling you" toast.
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:ended", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      durationSeconds: null,
      // Real failure time off the event, not a fanout-synthesized `new Date()`.
      endedAt: e.endedAt,
      status: "failed",
    });
  },

  "call.sdp_offer": (e, emitter) => {
    emitter.emitAboutConversation(e.workspaceId,
      e.conversationId, "call:sdp_offer", {
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      callId: e.callId,
      sdp: e.sdp,
    });
  },

};
