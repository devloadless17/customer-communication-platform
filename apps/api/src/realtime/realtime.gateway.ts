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
import type { Role } from "@ccp/shared/types";

import { DbService } from "../db/db.service";
import { PresenceService } from "./presence.service";
import { RealtimeEmitter, type TypedIO } from "./emitter.service";
import { channelRoom, conversationRoom, teamRoom } from "./rooms";
import { SocketAuthService } from "./socket-auth.service";
import { TypingService } from "./typing.service";

/**
 * Full Socket.io gateway. Owns room topology, handshake auth, idempotent
 * subscribe semantics, multi-tenant ownership checks on conversation and
 * channel joins, and auto-team-join on connect.
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

    // Handshake auth runs in middleware (not handleConnection) so an auth
    // failure delivers a typed `connect_error` to the client with a parseable
    // reason. The browser uses err.message to distinguish "session expired"
    // (route to /logout) from generic network blips (silent reconnect).
    // ws-adapter keeps `connectionStateRecovery.skipMiddlewares` at its
    // default (false), so this auth middleware RE-RUNS on every recovered
    // reconnect — that's deliberate (it closes the deactivation-survival
    // window; see ws-adapter.ts). The per-deploy reconnect-storm cost is
    // absorbed by the 15s session cache in session.guard.ts, not by skipping
    // re-auth. Do NOT set skipMiddlewares:true to "optimize" — it reintroduces
    // the bug where a closed-laptop deactivated user reconnects within the
    // recovery window and survives.
    // Handshake rate-limit by remote address. A deploy / WiFi flap
    // wakes 80 sockets at once; without a per-IP cap an authenticated
    // misbehaving page (or hostile client) can also fire unbounded
    // handshakes. Token bucket: 30 handshakes / 10s per IP — generous
    // enough for a tab cluster, tight enough to cap a hostile loop.
    // The bucket Map is bounded LRU so a high-cardinality attacker can't
    // OOM us.
    const handshakeBuckets = new Map<string, { tokens: number; ts: number }>();
    const HANDSHAKE_BUCKET_MAX = 10_000;
    const HANDSHAKE_REFILL_PER_MS = 30 / 10_000; // 30 per 10s
    const HANDSHAKE_CAP = 30;
    server.use((socket, next) => {
      const ip =
        (socket.handshake.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ??
        socket.handshake.address ??
        "unknown";
      const now = Date.now();
      let bucket = handshakeBuckets.get(ip);
      if (!bucket) {
        if (handshakeBuckets.size >= HANDSHAKE_BUCKET_MAX) {
          const oldest = handshakeBuckets.keys().next().value;
          if (oldest !== undefined) handshakeBuckets.delete(oldest);
        }
        bucket = { tokens: HANDSHAKE_CAP, ts: now };
        handshakeBuckets.set(ip, bucket);
      } else {
        const refill = (now - bucket.ts) * HANDSHAKE_REFILL_PER_MS;
        bucket.tokens = Math.min(HANDSHAKE_CAP, bucket.tokens + refill);
        bucket.ts = now;
      }
      if (bucket.tokens < 1) {
        // Tell the client this is transient (NOT auth failure) so its
        // reconnect backoff applies and it doesn't log the user out.
        return next(new Error("handshake_throttled"));
      }
      bucket.tokens -= 1;
      next();
    });

    server.use(async (socket, next) => {
      const result = await this.auth.authenticate(socket);
      if (result.kind === "ok") {
        socket.data.userId = result.identity.userId;
        socket.data.teamId = result.identity.teamId;
        socket.data.role = result.identity.role;
        return next();
      }
      if (result.kind === "unavailable") {
        // Auth backend degraded — instruct the client to reconnect rather
        // than navigate to /logout. The browser's connect_error handler
        // distinguishes this string from "unauthenticated".
        return next(new Error("auth_unavailable"));
      }
      // Error message is the wire payload (Socket.io serializes Error.message
      // into the client's `connect_error` event). Keep it stable — the
      // browser matches on this exact string.
      return next(new Error("unauthenticated"));
    });

    this.logger.log("Socket.io gateway ready");
  }

  async handleConnection(client: Socket): Promise<void> {
    // Identity was set in the middleware above. If somehow missing (e.g. a
    // recovered reconnect that skipped middleware AND lost socket.data) we
    // can't trust the connection — drop it.
    const userId = client.data.userId as string | undefined;
    const teamId = client.data.teamId as string | undefined;
    const role = client.data.role as Role | undefined;
    if (!userId || !teamId || !role) {
      client.disconnect(true);
      return;
    }
    const identity = { userId, teamId, role };

    // Identity already stashed on socket.data by the auth middleware in
    // afterInit. Initialize the per-socket Sets that @SubscribeMessage
    // handlers + handleDisconnect read for cleanup.
    client.data.typingIn = new Set<string>();
    client.data.typingInChannel = new Set<string>();
    client.data.typingInThread = new Set<string>();
    // Per-socket set of conversations this socket has joined as a viewer.
    // Used by disconnect to release the viewer slot without forcing the
    // client to send unsubscribe:conversation on tab close (browsers don't
    // reliably get a chance to send anything in beforeunload).
    client.data.viewingConversations = new Set<string>();

    // Auto-join the team room on connect. No explicit subscribe:team
    // round-trip needed — clients always belong to one team for the
    // lifetime of the connection.
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

    // Thread typing flags. Stored as `${channelId}::${threadRootId}` so we
    // can recover the channel room without an extra lookup — the channel
    // room is the dispatch target (no separate thread room exists).
    const typingInThread = client.data.typingInThread as Set<string> | undefined;
    if (typingInThread) {
      for (const composite of typingInThread) {
        const sepIdx = composite.indexOf("::");
        if (sepIdx === -1) continue;
        const channelId = composite.slice(0, sepIdx);
        const threadRootId = composite.slice(sepIdx + 2);
        this.typing.removeThread(threadRootId, userId, client.id);
        this.server.to(channelRoom(channelId)).emit("team:channel:thread:typing:update", {
          channelId,
          threadRootId,
          typingUserIds: this.typing.snapshotThread(threadRootId),
        });
      }
      typingInThread.clear();
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

  // ---- team presence ------------------------------------------------------
  // Pull-style snapshot request. The handshake-time `presence:update` only
  // reaches listeners that are already attached; route-navs that mount the
  // sidebar AFTER the handshake miss it, leaving teammates' dots grey until
  // the next presence change. The hook re-fires this on every `connect` so a
  // reconnect after a long offline (>2 min connectionStateRecovery window)
  // refreshes state without a page reload.
  @SubscribeMessage("presence:request")
  onPresenceRequest(@ConnectedSocket() client: Socket): void {
    const teamId = client.data.teamId as string | undefined;
    if (!teamId) return;
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
    if (!isValidBody(body, "conversationId")) return;
    const teamId = client.data.teamId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!teamId || !userId) return;
    const room = conversationRoom(body.conversationId);

    // Idempotency split: re-subscribe of an already-joined room (the common
    // reconnect path when socket.io's connectionStateRecovery restored the
    // room membership) skips the DB ownership check + the team-broadcast
    // but STILL re-emits fresh typing + viewer snapshots to this socket.
    // Without the snapshot re-emit, a long reconnect (past the
    // connectionStateRecovery window, or a suspended laptop) would leave
    // the client showing stale presence/typing pills until the next change
    // ticked — the audit called this out as a desync window. Cheap fix:
    // emit always; the snapshots are O(viewers) and capped by team size.
    const alreadyJoined = client.rooms.has(room);

    if (!alreadyJoined) {
      // Charge the rate-limit budget ONLY on the expensive first-join path
      // (the DB ownership check + team broadcast below). A re-subscribe is
      // cheap and MUST always reach the snapshot re-emit — otherwise a
      // team-wide reconnect storm could exhaust the shared subscribe bucket
      // and silently drop the typing/viewer snapshot on the displayed
      // thread, the exact desync the always-emit design exists to prevent.
      if (!checkSubscribeBudget(client, "subscribe:conversation")) return;
      try {
        const owns = await this.db.conversation.findFirst({
          where: { id: body.conversationId, teamId },
          select: { id: true },
        });
        if (!owns) return; // silently drop — fail-soft posture
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
    if (!isValidBody(body, "conversationId")) return;
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
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
    if (!isValidBody(body, "conversationId")) return;
    const userId = client.data.userId as string | undefined;
    const typingIn = client.data.typingIn as Set<string> | undefined;
    if (!userId || !typingIn) return;
    // Membership gate — mirror the channel/thread typing handlers (a malicious
    // client could otherwise inject a typing indicator + its userId into any
    // conversation room it never joined, including another team's; conversation
    // rooms aren't team-namespaced, so the join-time ownership check is the only
    // gate). typing:stop is implicitly protected by the `typingIn.delete` gate.
    if (!client.rooms.has(conversationRoom(body.conversationId))) return;
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
    if (!isValidBody(body, "conversationId")) return;
    const userId = client.data.userId as string | undefined;
    const typingIn = client.data.typingIn as Set<string> | undefined;
    if (!userId || !typingIn) return;
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
    if (!isValidBody(body, "channelId")) return;
    if (!checkSubscribeBudget(client, "subscribe:channel")) return;
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
    if (!isValidBody(body, "channelId")) return;
    const userId = client.data.userId as string | undefined;
    if (!userId) return;
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

  // (No subscribe:channel-thread handler — thread replies, edits, deletes,
  // and reactions are all delivered through the team room and filtered
  // client-side by `payload.threadRootId === rootMessageId`. The thread
  // room would be dead weight: every event source already targets the
  // team room, and the gateway-level DB lookup was paid for nothing.)

  @SubscribeMessage("typing:channel:start")
  onChannelTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): void {
    if (!isValidBody(body, "channelId")) return;
    const userId = client.data.userId as string | undefined;
    const typingInChannel = client.data.typingInChannel as Set<string> | undefined;
    if (!userId || !typingInChannel) return;
    // Anti-abuse: only count typing if the socket is actually in the channel
    // room. Otherwise a malicious client could spam typing into channels it
    // can't read.
    if (!client.rooms.has(channelRoom(body.channelId))) return;
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
    if (!isValidBody(body, "channelId")) return;
    const userId = client.data.userId as string | undefined;
    const typingInChannel = client.data.typingInChannel as Set<string> | undefined;
    if (!userId || !typingInChannel) return;
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
   * Thread typing — same shape as channel typing but scoped to a
   * `threadRootId`. Dispatched to the channel room (no separate thread
   * room exists); only tabs with the matching thread panel open will
   * render the indicator (client-side filter on `threadRootId`).
   *
   * Membership check: the socket must already be in the channel room.
   * The thread root's parent channel is the only thing we trust the
   * client about; everything else is rederived server-side.
   */
  @SubscribeMessage("typing:thread:start")
  onThreadTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string; threadRootId: string },
  ): void {
    if (!isValidBody(body, "channelId") || !isValidBody(body, "threadRootId")) return;
    const userId = client.data.userId as string | undefined;
    const typingInThread = client.data.typingInThread as Set<string> | undefined;
    if (!userId || !typingInThread) return;
    if (!client.rooms.has(channelRoom(body.channelId))) return;
    const composite = `${body.channelId}::${body.threadRootId}`;
    const wasTyping = typingInThread.has(composite);
    typingInThread.add(composite);
    this.typing.addThread(body.threadRootId, userId, client.id);
    if (!wasTyping) {
      this.server
        .to(channelRoom(body.channelId))
        .emit("team:channel:thread:typing:update", {
          channelId: body.channelId,
          threadRootId: body.threadRootId,
          typingUserIds: this.typing.snapshotThread(body.threadRootId),
        });
    }
  }

  @SubscribeMessage("typing:thread:stop")
  onThreadTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string; threadRootId: string },
  ): void {
    if (!isValidBody(body, "channelId") || !isValidBody(body, "threadRootId")) return;
    const userId = client.data.userId as string | undefined;
    const typingInThread = client.data.typingInThread as Set<string> | undefined;
    if (!userId || !typingInThread) return;
    const composite = `${body.channelId}::${body.threadRootId}`;
    if (!typingInThread.delete(composite)) return;
    this.typing.removeThread(body.threadRootId, userId, client.id);
    this.server
      .to(channelRoom(body.channelId))
      .emit("team:channel:thread:typing:update", {
        channelId: body.channelId,
        threadRootId: body.threadRootId,
        typingUserIds: this.typing.snapshotThread(body.threadRootId),
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

/**
 * Defensive shape guard for socket message bodies. The frontend always
 * sends well-formed payloads, but a hostile or buggy client can send
 * anything — `body.conversationId` on a null body throws TypeError. The
 * resulting unhandled-rejection is caught by process.on() but spams logs
 * and gives no signal to the operator about WHICH handler was hit. Guard
 * at the top of each handler instead.
 */
function isValidBody(
  body: unknown,
  key: string,
): body is Record<string, string> {
  if (body == null || typeof body !== "object") return false;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0;
}

/**
 * Per-socket token bucket for `subscribe:*` handlers. Without this, an
 * authenticated client (browser bug or hostile script) can spam 10k
 * subscribe requests/sec, each costing a Postgres roundtrip via the
 * tenant-ownership check. 30 subscribes/10s is generous for a tab cluster
 * but caps the worst case. Bucket lives in `client.data` so it dies with
 * the socket.
 */
const SUB_CAP = 30;
const SUB_REFILL_PER_MS = 30 / 10_000;
function checkSubscribeBudget(client: Socket, label: string): boolean {
  const now = Date.now();
   
  const data = client.data as any;
  let bucket = data.__subBucket as { tokens: number; ts: number } | undefined;
  if (!bucket) {
    bucket = { tokens: SUB_CAP, ts: now };
    data.__subBucket = bucket;
  } else {
    bucket.tokens = Math.min(
      SUB_CAP,
      bucket.tokens + (now - bucket.ts) * SUB_REFILL_PER_MS,
    );
    bucket.ts = now;
  }
  if (bucket.tokens < 1) {
    // Silent drop — surfacing 429 over a socket frame isn't a standard
    // pattern. The client's logs will show that the subscribe didn't
    // produce a reply; the LRU re-fetches on next interaction.
    void label;
    return false;
  }
  bucket.tokens -= 1;
  return true;
}
