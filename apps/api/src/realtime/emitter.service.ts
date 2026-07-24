import { Injectable, Logger } from "@nestjs/common";
import type { Server } from "socket.io";

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from "@ccp/shared/socket/events";

import { channelRoom, conversationRoom, workspaceRoom, userRoom } from "./rooms";

export type TypedIO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/**
 * Typed emit helpers — the only place app code reaches when fanning out a
 * server-originated event. The gateway sets `server` on init; until then,
 * emits warn-and-drop so a webhook arriving during boot doesn't 500 and
 * trigger a Meta retry.
 */
@Injectable()
export class RealtimeEmitter {
  private readonly logger = new Logger(RealtimeEmitter.name);
  private server: TypedIO | null = null;

  /** Called by RealtimeGateway in afterInit to publish the live IO server. */
  bind(server: TypedIO): void {
    this.server = server;
  }

  // ---------------------------------------------------------------------
  // Agent conversation-visibility fanout
  // ---------------------------------------------------------------------
  //
  // Under scoping, a restricted agent does NOT join the team room (see
  // RealtimeGateway.handleConnection) — that room carries message bodies,
  // contact PII and note text for the whole org. So every frame that is ABOUT
  // one conversation must additionally target the assignee's `user:` room, or
  // an agent would stop seeing their own work.
  //
  // One emit, two rooms: socket.io de-duplicates a socket that matches both, so
  // an unrestricted team (still in the team room) never receives a frame twice.
  //
  // Cost discipline: teams that haven't turned scoping on take a purely
  // synchronous path identical to `emitToTeam` — no lookup, no await, no
  // ordering change. Only opted-in teams pay, and even they hit an in-process
  // cache rather than the database on the hot path.

  /** workspaceId → restricted?, with a short TTL. */
  private readonly restrictedTeams = new Map<string, { at: number; value: boolean }>();
  /** conversationId → assignee, invalidated whenever an assignment changes. */
  private readonly assigneeCache = new Map<string, { at: number; value: string | null }>();
  private static readonly SCOPE_TTL_MS = 30_000;

  private scopeResolver:
    | ((workspaceId: string) => Promise<boolean>)
    | null = null;
  private assigneeResolver:
    | ((conversationId: string) => Promise<string | null>)
    | null = null;
  private contactAssigneeResolver:
    | ((contactId: string) => Promise<string | null>)
    | null = null;
  /** contactId → assignee of that contact's conversation. */
  private readonly contactAssigneeCache = new Map<
    string,
    { at: number; value: string | null }
  >();

  /** Bound on boot by RealtimeModule — keeps this service free of a Prisma
   *  import and mirrors how `channelActivityResolver` is wired. */
  bindVisibilityResolvers(
    isTeamRestricted: (workspaceId: string) => Promise<boolean>,
    assigneeOf: (conversationId: string) => Promise<string | null>,
    assigneeOfContact: (contactId: string) => Promise<string | null>,
  ): void {
    this.scopeResolver = isTeamRestricted;
    this.assigneeResolver = assigneeOf;
    this.contactAssigneeResolver = assigneeOfContact;
  }

  /**
   * Emit a frame that is ABOUT one contact (contact:updated / :created).
   *
   * These carry the contact's name, phone, email and custom fields, so they get
   * the same boundary as the conversation frames — routed to staff plus the
   * agent who owns that contact's conversation, so a restricted agent's contact
   * panel still updates live for their own customers.
   */
  emitAboutContact<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    contactId: string | null | undefined,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(`emitAboutContact("${String(event)}") dropped — IO not ready yet`);
      return;
    }
    const cachedScope = this.restrictedTeams.get(workspaceId);
    const scopeFresh =
      cachedScope && Date.now() - cachedScope.at < RealtimeEmitter.SCOPE_TTL_MS;
    if (scopeFresh && !cachedScope.value) {
      io.to(workspaceRoom(workspaceId)).emit(event, ...args);
      return;
    }
    if (scopeFresh && cachedScope.value && contactId) {
      const hit = this.contactAssigneeCache.get(contactId);
      if (hit && Date.now() - hit.at < RealtimeEmitter.SCOPE_TTL_MS) {
        this.emitToRooms(io, workspaceId, hit.value, event, args);
        return;
      }
    }
    void this.emitAboutContactSlow(workspaceId, contactId, event, args);
  }

  private async emitAboutContactSlow<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    contactId: string | null | undefined,
    event: E,
    args: Parameters<ServerToClientEvents[E]>,
  ): Promise<void> {
    const io = this.server;
    if (!io) return;
    try {
      let restricted = false;
      if (this.scopeResolver) {
        const hit = this.restrictedTeams.get(workspaceId);
        restricted =
          hit && Date.now() - hit.at < RealtimeEmitter.SCOPE_TTL_MS
            ? hit.value
            : await this.scopeResolver(workspaceId).then((v) => {
                this.restrictedTeams.set(workspaceId, { at: Date.now(), value: v });
                return v;
              });
      }
      if (!restricted) {
        io.to(workspaceRoom(workspaceId)).emit(event, ...args);
        return;
      }
      let assignee: string | null = null;
      if (contactId && this.contactAssigneeResolver) {
        assignee = await this.contactAssigneeResolver(contactId);
        this.contactAssigneeCache.set(contactId, { at: Date.now(), value: assignee });
      }
      this.emitToRooms(io, workspaceId, assignee, event, args);
    } catch (err) {
      this.logger.warn(
        `emitAboutContact("${String(event)}") degraded to staff-only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      io.to(workspaceRoom(workspaceId)).emit(event, ...args);
    }
  }

  /** Called when an assignment changes so the next frame targets the new
   *  owner immediately rather than up to a TTL later. */
  invalidateConversationAssignee(conversationId: string): void {
    this.assigneeCache.delete(conversationId);
  }

  /** Called when an admin flips the team setting. */
  invalidateTeamScope(workspaceId: string): void {
    this.restrictedTeams.delete(workspaceId);
  }

  /**
   * Emit a frame that is ABOUT one conversation.
   *
   * Use this — never `emitToTeam` — for anything carrying a message, a note, a
   * call, or a conversation's state. `emitToTeam` remains correct for genuinely
   * team-wide, non-conversation frames (catalog changes, presence, broadcasts).
   */
  emitAboutConversation<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    conversationId: string | null | undefined,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    this.emitAboutConversationAlso(workspaceId, conversationId, [], event, ...args);
  }

  /**
   * As `emitAboutConversation`, plus extra user rooms.
   *
   * Exists for exactly one case that the assignee-only audience gets wrong:
   * a REASSIGNMENT. The frame has to reach the PREVIOUS owner too, or their
   * inbox keeps showing a row they can no longer open until their next
   * refetch. The new owner is resolved as usual; the old one is passed in
   * explicitly from the event payload.
   */
  emitAboutConversationAlso<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    conversationId: string | null | undefined,
    alsoUserIds: readonly (string | null | undefined)[],
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(`emitAboutConversation("${String(event)}") dropped — IO not ready yet`);
      return;
    }

    const cachedScope = this.restrictedTeams.get(workspaceId);
    const scopeFresh =
      cachedScope && Date.now() - cachedScope.at < RealtimeEmitter.SCOPE_TTL_MS;

    const extra = alsoUserIds.filter((u): u is string => typeof u === "string" && !!u);

    // FAST PATH — known-unrestricted team: byte-identical to the old behavior.
    if (scopeFresh && !cachedScope.value) {
      io.to(workspaceRoom(workspaceId)).emit(event, ...args);
      return;
    }
    // FAST PATH — restricted team whose assignee we already know.
    if (scopeFresh && cachedScope.value && conversationId) {
      const cachedAssignee = this.assigneeCache.get(conversationId);
      if (cachedAssignee && Date.now() - cachedAssignee.at < RealtimeEmitter.SCOPE_TTL_MS) {
        this.emitToRooms(io, workspaceId, cachedAssignee.value, event, args, extra);
        return;
      }
    }

    void this.emitAboutConversationSlow(workspaceId, conversationId, event, args, extra);
  }

  private emitToRooms<E extends keyof ServerToClientEvents>(
    io: TypedIO,
    workspaceId: string,
    assignee: string | null,
    event: E,
    args: Parameters<ServerToClientEvents[E]>,
    alsoUserIds: readonly string[] = [],
  ): void {
    // The team room still holds admins/managers (and, on an unrestricted team,
    // everyone); the assignee room adds the one restricted agent who owns it;
    // `alsoUserIds` covers a handover's PREVIOUS owner. socket.io de-duplicates
    // a socket matching several of these, so nobody receives the frame twice.
    const rooms = new Set<string>([workspaceRoom(workspaceId)]);
    if (assignee) rooms.add(userRoom(workspaceId, assignee));
    for (const uid of alsoUserIds) rooms.add(userRoom(workspaceId, uid));
    io.to([...rooms]).emit(event, ...args);
  }

  private async emitAboutConversationSlow<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    conversationId: string | null | undefined,
    event: E,
    args: Parameters<ServerToClientEvents[E]>,
    alsoUserIds: readonly string[] = [],
  ): Promise<void> {
    const io = this.server;
    if (!io) return;
    try {
      let restricted = false;
      if (this.scopeResolver) {
        const hit = this.restrictedTeams.get(workspaceId);
        if (hit && Date.now() - hit.at < RealtimeEmitter.SCOPE_TTL_MS) {
          restricted = hit.value;
        } else {
          restricted = await this.scopeResolver(workspaceId);
          this.restrictedTeams.set(workspaceId, { at: Date.now(), value: restricted });
        }
      }
      if (!restricted) {
        io.to(workspaceRoom(workspaceId)).emit(event, ...args);
        return;
      }
      let assignee: string | null = null;
      if (conversationId && this.assigneeResolver) {
        const hit = this.assigneeCache.get(conversationId);
        if (hit && Date.now() - hit.at < RealtimeEmitter.SCOPE_TTL_MS) {
          assignee = hit.value;
        } else {
          assignee = await this.assigneeResolver(conversationId);
          this.assigneeCache.set(conversationId, { at: Date.now(), value: assignee });
        }
      }
      this.emitToRooms(io, workspaceId, assignee, event, args, alsoUserIds);
    } catch (err) {
      // Fail CLOSED to the staff room. Dropping an agent's own frame is
      // self-healing (the client reconciles on reconnect / next event);
      // blasting it team-wide on a DB fault would be the leak this whole
      // mechanism exists to prevent.
      this.logger.warn(
        `emitAboutConversation("${String(event)}") degraded to staff-only: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      io.to(workspaceRoom(workspaceId)).emit(event, ...args);
    }
  }

  emitToTeam<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(`emitToTeam("${String(event)}") dropped — IO not ready yet`);
      return;
    }
    io.to(workspaceRoom(workspaceId)).emit(event, ...args);
  }

  /**
   * Emit to every socket belonging to one user (all their tabs/devices).
   *
   * Use this when the audience is a KNOWN, explicit set of users — e.g. the
   * two participants of a DM. Unlike emitChannelScoped it needs no membership
   * resolver, because the caller already knows exactly who should receive it.
   */
  emitToUser<E extends keyof ServerToClientEvents>(
    workspaceId: string,
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(`emitToUser("${String(event)}") dropped — IO not ready yet`);
      return;
    }
    io.to(userRoom(workspaceId, userId)).emit(event, ...args);
  }

  emitToConversation<E extends keyof ServerToClientEvents>(
    conversationId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(
        `emitToConversation("${String(event)}") dropped — IO not ready yet`,
      );
      return;
    }
    io.to(conversationRoom(conversationId)).emit(event, ...args);
  }

  emitToChannel<E extends keyof ServerToClientEvents>(
    channelId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    const io = this.server;
    if (!io) {
      this.logger.warn(
        `emitToChannel("${String(event)}") dropped — IO not ready yet`,
      );
      return;
    }
    io.to(channelRoom(channelId)).emit(event, ...args);
  }

  // RT-1: resolve a channel's fanout audience (gateway binds this so the emitter
  // doesn't take a DB dep — same indirection as the presence snapshotter).
  // `isDefault` channels = the whole team; non-default = membership-gated.
  private channelActivityResolver:
    | ((channelId: string, workspaceId: string) => Promise<{ isDefault: boolean; memberUserIds: string[] }>)
    | null = null;
  bindChannelActivityResolver(
    fn: (channelId: string, workspaceId: string) => Promise<{ isDefault: boolean; memberUserIds: string[] }>,
  ): void {
    this.channelActivityResolver = fn;
  }

  /**
   * RT-1 / minor#10: emit a channel-scoped event to the RIGHT audience. For the
   * default channel (everyone is a member) it goes team-wide. For a
   * membership-gated channel it goes ONLY to the members' per-user rooms — so a
   * non-member never receives a private channel's metadata (channelId, author /
   * reader id, mentioned ids, …) on the wire.
   *
   * Fails CLOSED: if the resolver isn't bound yet (boot order) or throws (DB
   * fault), we DROP the frame rather than blast it team-wide. These are
   * low-value, self-healing frames (sidebar activity badge, read receipts) that
   * clients reconcile on the next event / reconnect, so dropping one on a rare
   * fault is strictly better than leaking a private channel's metadata to
   * non-members (the prior team-wide fallback did exactly that).
   */
  async emitChannelScoped<E extends keyof ServerToClientEvents>(
    channelId: string,
    workspaceId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): Promise<void> {
    const io = this.server;
    if (!io) {
      this.logger.warn(`emitChannelScoped("${String(event)}") dropped — IO not ready yet`);
      return;
    }
    const resolver = this.channelActivityResolver;
    if (!resolver) {
      // Fail closed: don't team-wide-blast a (possibly private) channel frame
      // before we can resolve its membership.
      this.logger.warn(
        `emitChannelScoped("${String(event)}") dropped — channel-activity resolver not bound yet`,
      );
      return;
    }
    let audience: { isDefault: boolean; memberUserIds: string[] };
    try {
      audience = await resolver(channelId, workspaceId);
    } catch (err) {
      // Fail closed: a self-healing badge/read-receipt frame dropped on a rare
      // DB fault is preferable to leaking private-channel metadata team-wide.
      this.logger.warn(
        `emitChannelScoped("${String(event)}") dropped — resolver failed for channel=${channelId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (audience.isDefault) {
      io.to(workspaceRoom(workspaceId)).emit(event, ...args);
      return;
    }
    for (const uid of audience.memberUserIds) {
      io.to(userRoom(workspaceId, uid)).emit(event, ...args);
    }
  }

  /**
   * Emit the SIDEBAR `team:channel:activity` badge frame to the right audience
   * (RT-1). Thin wrapper over emitChannelScoped.
   */
  async emitChannelActivity(
    channelId: string,
    workspaceId: string,
    payload: Parameters<ServerToClientEvents["team:channel:activity"]>[0],
  ): Promise<void> {
    await this.emitChannelScoped(channelId, workspaceId, "team:channel:activity", payload);
  }

  /**
   * Bound by the gateway at startup. Builds a fresh online-userIds snapshot
   * for a team, filtered for visible-online (users who picked "Appear
   * offline" are excluded even if their socket is connected). Lives on the
   * emitter so fanout rules can re-emit presence after a status change
   * without taking a circular dep on PresenceService / UsersService.
   */
  private presenceSnapshotter: ((workspaceId: string) => Promise<string[]>) | null = null;
  bindPresenceSnapshotter(fn: (workspaceId: string) => Promise<string[]>): void {
    this.presenceSnapshotter = fn;
  }

  /** Re-emit `presence:update` to the team room with a fresh visibly-online
   *  set. Used by `user.availability_changed` fanout so toggling "appear
   *  offline" updates teammates' green dots in the same frame as the badge. */
  private presenceDebounceTimers = new Map<string, NodeJS.Timeout>();
  private static readonly PRESENCE_DEBOUNCE_MS = 150;

  /**
   * Re-emit the team's presence snapshot, DEBOUNCED per team.
   *
   * This used to fire once per `user.availability_changed`, on the reasoning
   * that availability changes are rare manual clicks. Working hours made that
   * false: the schedule sweeper walks a whole team at a shift boundary, so a
   * 30-person org produced ~30 identical team-wide broadcasts (plus a DB read
   * and a widget relay each) at 09:00, again at 17:00, and again at local
   * midnight when the "back tomorrow" text rolls over.
   *
   * Coalescing is safe because the snapshot is BUILT when the timer fires, so
   * the single emitted frame carries the by-then current state — the same
   * idempotence argument the viewers debounce above relies on.
   */
  emitPresenceSnapshot(workspaceId: string): void {
    const existing = this.presenceDebounceTimers.get(workspaceId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.presenceDebounceTimers.delete(workspaceId);
      void this.doEmitPresenceSnapshot(workspaceId);
    }, RealtimeEmitter.PRESENCE_DEBOUNCE_MS);
    // Don't hold the event loop open on shutdown for a presence frame.
    timer.unref?.();
    this.presenceDebounceTimers.set(workspaceId, timer);
  }

  private async doEmitPresenceSnapshot(workspaceId: string): Promise<void> {
    const io = this.server;
    const snapshot = this.presenceSnapshotter;
    if (!io || !snapshot) {
      this.logger.warn(
        "emitPresenceSnapshot dropped — IO or snapshotter not ready yet",
      );
      return;
    }
    const onlineUserIds = await snapshot(workspaceId);
    io.to(workspaceRoom(workspaceId)).emit("presence:update", { workspaceId, onlineUserIds });
  }

  // Snapshotters wired by the gateway so the "also viewing" pill can be
  // refreshed when a user's availability flips (busy/away/offline drop them
  // out, going back to available re-adds them). Kept here so fanout-rules
  // doesn't need a direct ref to PresenceService or the gateway.
  private conversationViewersSnapshotter:
    | ((conversationId: string) => Promise<string[]>)
    | null = null;
  bindConversationViewersSnapshotter(
    fn: (conversationId: string) => Promise<string[]>,
  ): void {
    this.conversationViewersSnapshotter = fn;
  }
  private conversationsViewedByUser: ((userId: string) => string[]) | null = null;
  bindConversationsViewedByUser(fn: (userId: string) => string[]): void {
    this.conversationsViewedByUser = fn;
  }

  // Per-user debounce timers for the viewers re-emit. Multiple rapid
  // availability changes (rapid "available → busy → away" toggling, or a
  // workflow that bumps status repeatedly) would otherwise fire one
  // Promise.all-over-N-conversations per change. Collapsing to one re-emit
  // is safe: the snapshot is built when the timer fires, so the final
  // emitted state is the by-then current state (idempotent).
  private viewersDebounceTimers = new Map<string, NodeJS.Timeout>();
  private static readonly VIEWERS_DEBOUNCE_MS = 120;

  /**
   * Re-emit `conversation:viewers` for every conversation room the user is
   * currently a viewer in. Used by `user.availability_changed` fanout so
   * teammates' "also viewing" pills update in the same frame as the badge
   * — going busy/away/offline removes the user from the pill, going
   * available adds them back. No-op when the user isn't viewing anything.
   *
   * Debounced per-user: rapid availability changes coalesce into one re-emit.
   */
  emitConversationViewersForUser(userId: string): void {
    const existing = this.viewersDebounceTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.viewersDebounceTimers.delete(userId);
      void this.doEmitConversationViewersForUser(userId);
    }, RealtimeEmitter.VIEWERS_DEBOUNCE_MS);
    this.viewersDebounceTimers.set(userId, timer);
  }

  private async doEmitConversationViewersForUser(userId: string): Promise<void> {
    const io = this.server;
    const conversationsFor = this.conversationsViewedByUser;
    const viewersFor = this.conversationViewersSnapshotter;
    if (!io || !conversationsFor || !viewersFor) {
      this.logger.warn(
        "emitConversationViewersForUser dropped — IO or snapshotter not ready yet",
      );
      return;
    }
    const conversationIds = conversationsFor(userId);
    if (conversationIds.length === 0) return;
    await Promise.all(
      conversationIds.map(async (conversationId) => {
        const viewerUserIds = await viewersFor(conversationId);
        io.to(conversationRoom(conversationId)).emit("conversation:viewers", {
          conversationId,
          viewerUserIds,
        });
      }),
    );
  }
}
