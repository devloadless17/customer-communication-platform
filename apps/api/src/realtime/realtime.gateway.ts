import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";

import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@ccp/shared/socket/events";

import { DbService } from "../db/db.service";
import { PresenceService } from "./presence.service";
import { RealtimeEmitter, type TypedIO } from "./emitter.service";
import {
  channelRoom,
  channelThreadRoom,
  conversationRoom,
  teamRoom,
} from "./rooms";
import { SocketAuthService } from "./socket-auth.service";
import { TypingService } from "./typing.service";

/**
 * Full Socket.io gateway. Faithfully ports the pre-migration custom-server
 * gateway in [lib/socket/server.ts](../../../../../lib/socket/server.ts) —
 * same room topology, same handshake, same idempotent subscribe semantics,
 * same multi-tenant ownership checks on conversation and channel joins,
 * same auto-team-join on connect.
 *
 * `@WebSocketGateway` options are intentionally minimal here — the real
 * Socket.io tuning (path, CORS, connection-state-recovery, pingTimeout,
 * maxHttpBufferSize, perMessageDeflate, transports) is centralized in
 * [ws-adapter.ts](./ws-adapter.ts) so this file stays focused on event
 * handling.
 */
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: TypedIO;

  constructor(
    private readonly db: DbService,
    private readonly auth: SocketAuthService,
    private readonly presence: PresenceService,
    private readonly typing: TypingService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  afterInit(server: TypedIO): void {
    this.emitter.bind(server);
    this.logger.log("Socket.io gateway ready");
  }

  async handleConnection(client: Socket): Promise<void> {
    const identity = await this.auth.authenticate(client);
    if (!identity) {
      client.disconnect(true);
      return;
    }

    // Stash identity on socket.data — the same shape the old SocketData
    // interface declared. Downstream `@SubscribeMessage` handlers trust this
    // and NEVER read identity from the event payload.
    client.data.userId = identity.userId;
    client.data.teamId = identity.teamId;
    client.data.role = identity.role;
    client.data.typingIn = new Set<string>();
    client.data.typingInChannel = new Set<string>();
    // Per-socket set of conversations this socket has joined as a viewer.
    // Used by disconnect to release the viewer slot without forcing the
    // client to send unsubscribe:conversation on tab close (browsers don't
    // reliably get a chance to send anything in beforeunload).
    client.data.viewingConversations = new Set<string>();

    // Auto-join the team room on connect. Previously some code paths
    // forgot the explicit subscribe:team emit and silently received zero
    // team-wide events — that footgun is closed by the auto-join.
    client.join(teamRoom(identity.teamId));

    const cameOnline = this.presence.add(
      identity.teamId,
      identity.userId,
      client.id,
    );
    // Snapshot to THIS socket immediately so the user's own dot lights up
    // without waiting for the next presence change.
    client.emit("presence:update", {
      teamId: identity.teamId,
      onlineUserIds: this.presence.snapshot(identity.teamId),
    });
    // Broadcast a fresh snapshot to the rest of the team ONLY when this
    // connect transitioned the user from 0→1 sockets. Without the gate
    // every additional tab / Caddy bounce reconnect spammed a team-wide
    // emit even though the onlineUserIds list didn't change.
    if (cameOnline) {
      this.server.to(teamRoom(identity.teamId)).emit("presence:update", {
        teamId: identity.teamId,
        onlineUserIds: this.presence.snapshot(identity.teamId),
      });
    }
  }

  handleDisconnect(client: Socket): void {
    const teamId = client.data.teamId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!teamId || !userId) return;

    // Drop typing flags FIRST — these are per-conversation and need their
    // own emit even if presence didn't tick.
    const typingIn = client.data.typingIn as Set<string> | undefined;
    if (typingIn) {
      for (const conversationId of typingIn) {
        this.typing.removeConv(conversationId, userId, client.id);
        this.server.to(conversationRoom(conversationId)).emit("typing:update", {
          conversationId,
          typingUserIds: this.typing.snapshotConv(conversationId),
        });
      }
      typingIn.clear();
    }

    const typingInChannel = client.data.typingInChannel as Set<string> | undefined;
    if (typingInChannel) {
      for (const channelId of typingInChannel) {
        this.typing.removeChannel(channelId, userId, client.id);
        this.server.to(channelRoom(channelId)).emit("team:channel:typing:update", {
          channelId,
          typingUserIds: this.typing.snapshotChannel(channelId),
        });
      }
      typingInChannel.clear();
    }

    // Release viewer slots for every conversation this socket was viewing.
    // Only re-broadcast when the LAST tab from this user dropped (the
    // user-level 1→0 transition), so a multi-tab agent staying open in
    // another tab doesn't flicker off the viewer pill.
    const viewing = client.data.viewingConversations as Set<string> | undefined;
    if (viewing) {
      for (const conversationId of viewing) {
        const userLeft = this.presence.removeViewer(
          conversationId,
          userId,
          client.id,
        );
        if (userLeft) {
          this.server.to(conversationRoom(conversationId)).emit("conversation:viewers", {
            conversationId,
            viewerUserIds: this.presence.snapshotViewers(conversationId),
          });
        }
      }
      viewing.clear();
    }

    const wentOffline = this.presence.remove(teamId, userId, client.id);
    if (wentOffline) {
      this.server.to(teamRoom(teamId)).emit("presence:update", {
        teamId,
        onlineUserIds: this.presence.snapshot(teamId),
      });
    }
  }

  // ---- subscribe:team -----------------------------------------------------
  // Kept for backwards compat with clients that still explicitly emit it.
  // Auto-join in handleConnection covers the common case; this just refreshes
  // the user's presence snapshot on demand.
  @SubscribeMessage("subscribe:team")
  onSubscribeTeam(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { teamId: string },
  ): void {
    const teamId = client.data.teamId as string | undefined;
    if (!teamId || teamId !== body.teamId) return;
    client.join(teamRoom(teamId));
    client.emit("presence:update", {
      teamId,
      onlineUserIds: this.presence.snapshot(teamId),
    });
  }

  // ---- conversation rooms -------------------------------------------------
  @SubscribeMessage("subscribe:conversation")
  async onSubscribeConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    const teamId = client.data.teamId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!teamId || !userId) return;
    const room = conversationRoom(body.conversationId);

    // Idempotency split: re-subscribe of an already-joined room (the common
    // reconnect path when socket.io's connectionStateRecovery restored the
    // room membership) skips the DB ownership check + the team-broadcast
    // but STILL re-emits fresh typing + viewer snapshots to this socket.
    // Without the snapshot re-emit, a long reconnect (>2 min, or a
    // suspended laptop) would leave the client showing stale presence/
    // typing pills until the next change ticked — the audit called this
    // out as a desync window. Cheap fix: emit always; the snapshots are
    // O(viewers) and capped by team size.
    const alreadyJoined = client.rooms.has(room);

    if (!alreadyJoined) {
      try {
        const owns = await this.db.conversation.findFirst({
          where: { id: body.conversationId, teamId },
          select: { id: true },
        });
        if (!owns) return; // silently drop — same posture as pre-migration
      } catch (err) {
        this.logger.error(`subscribe:conversation lookup failed: ${err}`);
        return;
      }
      client.join(room);
    }

    // Always re-emit typing snapshot — handles both first-subscribe and
    // re-subscribe after a long reconnect.
    client.emit("typing:update", {
      conversationId: body.conversationId,
      typingUserIds: this.typing.snapshotConv(body.conversationId),
    });

    // Register as a viewer (idempotent at the presence layer — add is a
    // no-op when this socketId is already in the set). Track on the socket
    // so disconnect cleans up.
    const viewing = client.data.viewingConversations as Set<string>;
    viewing.add(body.conversationId);
    const startedViewing = this.presence.addViewer(
      body.conversationId,
      userId,
      client.id,
    );
    // Snapshot to THIS socket immediately so the pill paints without
    // waiting for the next change — same posture as team presence. Fires
    // on every (re-)subscribe so a long reconnect catches a fresh snapshot.
    client.emit("conversation:viewers", {
      conversationId: body.conversationId,
      viewerUserIds: this.presence.snapshotViewers(body.conversationId),
    });
    // Broadcast a fresh snapshot to the rest of the room only when this
    // user crossed 0→1 sockets. Multiple tabs from the same user must not
    // re-spam the team or the pill will flicker on every Caddy bounce.
    if (startedViewing) {
      this.server.to(room).emit("conversation:viewers", {
        conversationId: body.conversationId,
        viewerUserIds: this.presence.snapshotViewers(body.conversationId),
      });
    }
  }

  @SubscribeMessage("unsubscribe:conversation")
  onUnsubscribeConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): void {
    const userId = client.data.userId as string;
    client.leave(conversationRoom(body.conversationId));
    const typingIn = client.data.typingIn as Set<string> | undefined;
    if (typingIn?.delete(body.conversationId)) {
      this.typing.removeConv(body.conversationId, userId, client.id);
      this.server
        .to(conversationRoom(body.conversationId))
        .emit("typing:update", {
          conversationId: body.conversationId,
          typingUserIds: this.typing.snapshotConv(body.conversationId),
        });
    }

    // Release viewer slot. Broadcast only when the user crossed 1→0 — a
    // second tab still viewing keeps the user on the pill.
    const viewing = client.data.viewingConversations as Set<string> | undefined;
    if (viewing?.delete(body.conversationId)) {
      const userLeft = this.presence.removeViewer(
        body.conversationId,
        userId,
        client.id,
      );
      if (userLeft) {
        this.server
          .to(conversationRoom(body.conversationId))
          .emit("conversation:viewers", {
            conversationId: body.conversationId,
            viewerUserIds: this.presence.snapshotViewers(body.conversationId),
          });
      }
    }
  }

  @SubscribeMessage("typing:start")
  onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): void {
    const userId = client.data.userId as string;
    const typingIn = client.data.typingIn as Set<string>;
    const wasTyping = typingIn.has(body.conversationId);
    typingIn.add(body.conversationId);
    this.typing.addConv(body.conversationId, userId, client.id);
    if (!wasTyping) {
      this.server
        .to(conversationRoom(body.conversationId))
        .emit("typing:update", {
          conversationId: body.conversationId,
          typingUserIds: this.typing.snapshotConv(body.conversationId),
        });
    }
  }

  @SubscribeMessage("typing:stop")
  onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): void {
    const userId = client.data.userId as string;
    const typingIn = client.data.typingIn as Set<string>;
    if (!typingIn.delete(body.conversationId)) return;
    this.typing.removeConv(body.conversationId, userId, client.id);
    this.server
      .to(conversationRoom(body.conversationId))
      .emit("typing:update", {
        conversationId: body.conversationId,
        typingUserIds: this.typing.snapshotConv(body.conversationId),
      });
  }

  // ---- team-chat channel rooms -------------------------------------------
  @SubscribeMessage("subscribe:channel")
  async onSubscribeChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): Promise<void> {
    const teamId = client.data.teamId as string | undefined;
    if (!teamId) return;
    const room = channelRoom(body.channelId);
    if (client.rooms.has(room)) return;
    try {
      const owns = await this.db.teamChannel.findFirst({
        where: { id: body.channelId, teamId },
        select: { id: true },
      });
      if (!owns) return;
    } catch (err) {
      this.logger.error(`subscribe:channel lookup failed: ${err}`);
      return;
    }
    client.join(room);
    client.emit("team:channel:typing:update", {
      channelId: body.channelId,
      typingUserIds: this.typing.snapshotChannel(body.channelId),
    });
  }

  @SubscribeMessage("unsubscribe:channel")
  onUnsubscribeChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): void {
    const userId = client.data.userId as string;
    client.leave(channelRoom(body.channelId));
    const typingInChannel = client.data.typingInChannel as Set<string> | undefined;
    if (typingInChannel?.delete(body.channelId)) {
      this.typing.removeChannel(body.channelId, userId, client.id);
      this.server
        .to(channelRoom(body.channelId))
        .emit("team:channel:typing:update", {
          channelId: body.channelId,
          typingUserIds: this.typing.snapshotChannel(body.channelId),
        });
    }
  }

  // Thread side-panel rooms — verify ownership of the root message before
  // joining. Originally relied on "no emitter targets a stranger's thread
  // room" as the gate, but any future code path that emits to
  // channelThreadRoom(id) without re-checking team would leak across
  // tenants. Cheap DB lookup (PK + teamId) once per subscribe.
  @SubscribeMessage("subscribe:channel-thread")
  async onSubscribeChannelThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { rootMessageId: string },
  ): Promise<void> {
    const teamId = client.data.teamId as string;
    const room = channelThreadRoom(body.rootMessageId);
    // Idempotency guard — a chatty client (or a reconnect retry) re-emits
    // subscribe:channel-thread, which would otherwise re-pay the
    // findFirst on every emit. The room-membership check is O(1) on
    // the socket's joined-rooms set and short-circuits the DB lookup.
    if (client.rooms.has(room)) return;
    const root = await this.db.teamChannelMessage.findFirst({
      where: { id: body.rootMessageId, teamId },
      select: { id: true },
    });
    if (!root) return;
    client.join(room);
  }

  @SubscribeMessage("unsubscribe:channel-thread")
  onUnsubscribeChannelThread(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { rootMessageId: string },
  ): void {
    client.leave(channelThreadRoom(body.rootMessageId));
  }

  @SubscribeMessage("typing:channel:start")
  onChannelTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): void {
    const userId = client.data.userId as string;
    // Anti-abuse: only count typing if the socket is actually in the channel
    // room. Otherwise a malicious client could spam typing into channels it
    // can't read.
    if (!client.rooms.has(channelRoom(body.channelId))) return;
    const typingInChannel = client.data.typingInChannel as Set<string>;
    const wasTyping = typingInChannel.has(body.channelId);
    typingInChannel.add(body.channelId);
    this.typing.addChannel(body.channelId, userId, client.id);
    if (!wasTyping) {
      this.server
        .to(channelRoom(body.channelId))
        .emit("team:channel:typing:update", {
          channelId: body.channelId,
          typingUserIds: this.typing.snapshotChannel(body.channelId),
        });
    }
  }

  @SubscribeMessage("typing:channel:stop")
  onChannelTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): void {
    const userId = client.data.userId as string;
    const typingInChannel = client.data.typingInChannel as Set<string>;
    if (!typingInChannel.delete(body.channelId)) return;
    this.typing.removeChannel(body.channelId, userId, client.id);
    this.server
      .to(channelRoom(body.channelId))
      .emit("team:channel:typing:update", {
        channelId: body.channelId,
        typingUserIds: this.typing.snapshotChannel(body.channelId),
      });
  }

  /**
   * Hard-disconnect every live socket for a given user. Called by the
   * deactivation flow — without this, the deactivated user's already-open
   * tabs keep receiving live team events. Type-only export so feature
   * modules can grab the gateway and call it during the user delete flow.
   */
  disconnectUserSockets(userId: string): number {
    const socketIds = this.presence.socketsFor(userId);
    let count = 0;
    for (const id of socketIds) {
      const s = this.server.sockets.sockets.get(id);
      if (s) {
        s.disconnect(true);
        count++;
      }
    }
    return count;
  }
}

// Re-export Server typed event names for ergonomic consumer imports.
export type { ClientToServerEvents, ServerToClientEvents };
