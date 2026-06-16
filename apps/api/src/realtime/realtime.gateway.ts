import { Logger, type OnModuleDestroy } from "@nestjs/common";
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
import { channelRoom, conversationRoom, teamRoom, userRoom } from "./rooms";
import { SocketAuthService } from "./socket-auth.service";
import { TypingService } from "./typing.service";

// Per-socket emit cap — see comment at the install site in handleConnection.
const SOCKET_EMIT_CAP = 240;
const SOCKET_EMIT_REFILL_PER_MS = 240 / 10_000;

// realtime-added-1: outbound write-buffer reaper. `maxHttpBufferSize` (ws-adapter)
// caps INBOUND frame size; the per-socket emit bucket above caps INBOUND rate.
// Neither bounds the OUTBOUND engine.io writeBuffer — a slow-but-alive consumer
// (throttled mobile link) keeps acking pings (so pingTimeout never reaps it) yet
// can't drain a broadcast storm, so its pending-packet buffer grows unbounded and
// pins server heap. A periodic sweep disconnects any socket whose writeBuffer
// exceeds the threshold; the client reconnects + backfills (convergence re-syncs),
// trading one bad socket's liveness for bounded server memory. Threshold is well
// above any legitimate transient backlog.
const WRITE_BUFFER_REAP_THRESHOLD = 2_000;
const WRITE_BUFFER_REAP_INTERVAL_MS = 10_000;

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
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  onModuleDestroy(): void {
    if (this.writeBufferReaper) {
      clearInterval(this.writeBufferReaper);
      this.writeBufferReaper = null;
    }
  }

  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: TypedIO;

  // realtime-added-1: handle for the outbound write-buffer reaper (cleared on
  // shutdown so the interval doesn't keep the process alive / leak on HMR).
  private writeBufferReaper: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DbService,
    private readonly auth: SocketAuthService,
    private readonly presence: PresenceService,
    private readonly typing: TypingService,
    private readonly emitter: RealtimeEmitter,
  ) {}

  afterInit(server: TypedIO): void {
    this.emitter.bind(server);
    // Wire the visibly-online snapshot used by the `user.availability_changed`
    // fanout. Single shared source of truth: connected userIds intersected
    // with "not marked offline" — same rule as `buildVisibleOnlineSnapshot`
    // below (the connect path uses the helper directly; fanout uses this
    // indirection so the emitter doesn't take a circular dep on the gateway).
    this.emitter.bindPresenceSnapshotter((teamId) =>
      this.buildVisibleOnlineSnapshot(teamId),
    );
    // Same indirection for the per-conversation viewer pill — the
    // `user.availability_changed` fanout re-emits `conversation:viewers`
    // for every room the user is in so a status flip drops/restores them
    // from teammates' "also viewing" pills in the same frame as the badge.
    this.emitter.bindConversationViewersSnapshotter(async (conversationId) => {
      const teamId = await this.teamIdForConversation(conversationId);
      if (teamId === null) return [];
      return this.buildVisibleViewers(conversationId, teamId);
    });
    this.emitter.bindConversationsViewedByUser((userId) =>
      this.presence.conversationsViewedBy(userId),
    );
    // RT-1: resolve a channel's activity-badge audience. Default channel →
    // whole team; membership-gated channel → just its members (their user
    // rooms), so a private channel's activity never reaches non-members.
    this.emitter.bindChannelActivityResolver(async (channelId, teamId) => {
      const channel = await this.db.teamChannel.findFirst({
        where: { id: channelId, teamId },
        select: { isDefault: true, members: { select: { userId: true } } },
      });
      if (!channel) return { isDefault: false, memberUserIds: [] };
      return {
        isDefault: channel.isDefault,
        memberUserIds: channel.members.map((m) => m.userId),
      };
    });

    // realtime-added-1: start the outbound write-buffer reaper. Disconnects a
    // slow consumer whose pending-packet buffer has blown past the threshold
    // (it acks pings, so pingTimeout won't catch it) before it pins heap.
    this.writeBufferReaper = setInterval(() => {
      let reaped = 0;
      for (const socket of server.sockets.sockets.values()) {
        // engine.io types `writeBuffer` as private; reach it via unknown. It's
        // the array of packets pending write to this socket's transport.
        const buf = (socket.conn as unknown as { writeBuffer?: unknown[] })
          ?.writeBuffer;
        if (buf && buf.length > WRITE_BUFFER_REAP_THRESHOLD) {
          socket.disconnect(true);
          reaped += 1;
        }
      }
      if (reaped > 0) {
        this.logger.warn(
          `[realtime] reaped ${reaped} socket(s) with outbound writeBuffer > ${WRITE_BUFFER_REAP_THRESHOLD} packets`,
        );
      }
    }, WRITE_BUFFER_REAP_INTERVAL_MS);
    this.writeBufferReaper.unref?.();

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
    // handshakes. Token bucket: 200 handshakes / 10s per IP. A whole office
    // shares ONE NAT IP, so on a deploy / Caddy-bounce reconnect storm a team
    // (CLAUDE.md anticipates ~80 agents, × multiple tabs) bursts well past the
    // old cap of 30 — and tripping it returned `handshake_throttled` to LEGIT
    // clients, whose reconnect backoff then cascaded into the exact visible
    // flakiness CLAUDE.md warns about. The session cookie-cache (15s, see
    // socket-auth.service) already absorbs the per-handshake DB cost of a
    // storm, so this bucket only needs to bound a pathological runaway loop
    // (which fires thousands/sec); 20/sec sustained does that while never
    // tripping a legit office. The bucket Map is bounded LRU so a
    // high-cardinality attacker can't OOM us.
    const handshakeBuckets = new Map<string, { tokens: number; ts: number }>();
    const HANDSHAKE_BUCKET_MAX = 10_000;
    const HANDSHAKE_REFILL_PER_MS = 200 / 10_000; // 200 per 10s
    const HANDSHAKE_CAP = 200;
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
    // Per-socket cache of `${channelId}::${threadRootId}` composites that have
    // passed the "this thread root actually belongs to this channel" check.
    // The first thread-typing toggle for a composite verifies it server-side
    // (mirrors subscribe:channel's first-join membership check); validated
    // composites skip the DB lookup on every later re-toggle.
    client.data.validatedThreads = new Set<string>();
    // Per-socket set of conversations this socket has joined as a viewer.
    // Used by disconnect to release the viewer slot without forcing the
    // client to send unsubscribe:conversation on tab close (browsers don't
    // reliably get a chance to send anything in beforeunload).
    client.data.viewingConversations = new Set<string>();

    // Per-socket emit rate limit. The HTTP RateLimitInterceptor short-circuits on
    // socket frames (no req.session), so without this a compromised tab can
    // spam typing / reaction / subscribe events unbounded. Token bucket:
    // 240 events / 10s burst (~24/sec sustained) — well above legitimate
    // use (typing throttles client-side at 3/sec, message sends are HTTP
    // not socket), tight enough that a runaway loop or hostile script
    // can't drown the gateway or fan out spam to teammates.
    let socketBucketTokens = SOCKET_EMIT_CAP;
    let socketBucketTs = Date.now();
    client.use((_, next) => {
      const now = Date.now();
      socketBucketTokens = Math.min(
        SOCKET_EMIT_CAP,
        socketBucketTokens + (now - socketBucketTs) * SOCKET_EMIT_REFILL_PER_MS,
      );
      socketBucketTs = now;
      if (socketBucketTokens < 1) {
        // Reject the event silently — emitting an error frame would let a
        // hostile script trigger reply-amplification. The `client.on("error")`
        // listener below converts this into a quiet drop: socket.io routes a
        // middleware rejection through `_onerror` → the socket's reserved
        // `error` event, and without a listener Node's EventEmitter promotes an
        // un-handled `error` to an uncaughtException + full-stack console.error
        // per dropped frame — turning the "pure drop" into log spam + sync
        // stdout writes during exactly the abuse storm this bucket exists to
        // absorb.
        return next(new Error("rate_limited"));
      }
      socketBucketTokens -= 1;
      next();
    });

    // Absorb socket-level `error` events so a rejected middleware frame (the
    // rate-limit drop above, or any malformed-frame error socket.io surfaces)
    // doesn't reach Node's EventEmitter `error`-promotion path. No listener =>
    // every drop becomes an uncaughtException; one no-op listener => a quiet
    // drop, as the bucket intends. Logged at debug (sampled by the runtime's
    // log level) so a genuine flood is still observable without spamming prod.
    client.on("error", (err) => {
      this.logger.debug(`socket ${client.id} error frame dropped: ${err}`);
    });

    // Auto-join the team room on connect. No explicit subscribe:team
    // round-trip needed — clients always belong to one team for the
    // lifetime of the connection.
    client.join(teamRoom(identity.teamId));
    // Per-user room (RT-1) — lets the server target this user across all their
    // tabs for membership-scoped fanout (private-channel activity badges)
    // without a team-wide broadcast that leaks metadata to non-members.
    client.join(userRoom(identity.userId));

    const cameOnline = this.presence.add(
      identity.teamId,
      identity.userId,
      client.id,
    );
    // Visibly-online snapshot — connected users intersected with "not marked
    // offline" so an agent who picked "Appear offline" doesn't show up on
    // teammates' green dots even though their socket is connected. The async
    // DB read happens at most once per connect (rare); after that the gateway
    // handles user.availability_changed via the fanout's emitPresenceSnapshot
    // path, not on every emit.
    const onlineUserIds = await this.buildVisibleOnlineSnapshot(identity.teamId);
    // Snapshot to THIS socket immediately so the user's own dot lights up
    // without waiting for the next presence change.
    client.emit("presence:update", {
      teamId: identity.teamId,
      onlineUserIds,
    });
    // Seed availability for every teammate in one frame so the freshly-loaded
    // tab paints right immediately, without waiting for a teammate to change
    // status. Reuses the same DB read that built the presence snapshot
    // shape-wise — kept as separate frames so consumers can subscribe to
    // either independently (presence and availability are orthogonal).
    void this.emitAvailabilitySnapshot(identity.teamId, client).catch((err) =>
      this.logger.error(`emitAvailabilitySnapshot (connect) failed: ${err}`),
    );
    // Broadcast a fresh snapshot to the rest of the team ONLY when this
    // connect transitioned the user from 0→1 sockets. Without the gate
    // every additional tab / Caddy bounce reconnect spammed a team-wide
    // emit even though the onlineUserIds list didn't change.
    if (cameOnline) {
      this.server.to(teamRoom(identity.teamId)).emit("presence:update", {
        teamId: identity.teamId,
        onlineUserIds,
      });
    }
  }

  /**
   * Compute the team's visibly-online userIds: presence (≥1 socket) intersected
   * with `availabilityStatus !== "offline"`. One DB read on a small set
   * (already-connected users only) — fine for a single-VPS pilot; on a hot
   * path we'd cache it, but presence snapshots are rare events (connect /
   * status flip), not per-message.
   */
  private async buildVisibleOnlineSnapshot(teamId: string): Promise<string[]> {
    const connected = this.presence.snapshot(teamId);
    if (connected.length === 0) return [];
    try {
      const rows = await this.db.user.findMany({
        where: { teamId, id: { in: connected } },
        select: { id: true, availabilityStatus: true },
      });
      const offline = new Set(
        rows.filter((r) => r.availabilityStatus === "offline").map((r) => r.id),
      );
      return connected.filter((id) => !offline.has(id));
    } catch (err) {
      // Same fail-soft posture as buildVisibleViewers: under transient Postgres
      // flapping (e.g. a reconnect storm during a deploy) fall back to the raw
      // connected set rather than rejecting. Over-showing a teammate who picked
      // "Appear offline" for one tick beats going blank or — worse, on the
      // connect/disconnect paths that don't await this — leaking an unhandled
      // rejection and dropping the presence:update entirely.
      this.logger.error(`buildVisibleOnlineSnapshot lookup failed: ${err}`);
      return connected;
    }
  }

  /**
   * Filter the raw viewer set for a conversation down to "visible viewers":
   * only users whose `availabilityStatus === "available"`. Busy / away /
   * appear-offline drop out — they're still viewing the thread, but the
   * "also viewing" pill is a hand-off signal, not a presence trace.
   *
   * Cost is one indexed lookup on a tiny set (active viewers, almost always
   * ≤ team size). Falls back to the unfiltered set on DB error — the pill
   * over-showing is a smaller regression than going blank under transient
   * Postgres flapping.
   */
  private async buildVisibleViewers(
    conversationId: string,
    teamId: string,
  ): Promise<string[]> {
    const viewers = this.presence.snapshotViewers(conversationId);
    if (viewers.length === 0) return [];
    try {
      const rows = await this.db.user.findMany({
        where: { teamId, id: { in: viewers } },
        select: { id: true, availabilityStatus: true },
      });
      const available = new Set(
        rows
          .filter((r) => (r.availabilityStatus ?? "available") === "available")
          .map((r) => r.id),
      );
      return viewers.filter((id) => available.has(id));
    } catch (err) {
      this.logger.error(`buildVisibleViewers lookup failed: ${err}`);
      return viewers;
    }
  }

  /**
   * Resolve the teamId for a conversation room. Used by the viewers
   * snapshotter so the cross-event re-emit (on availability flip) can
   * filter by the right team. Cheap indexed read; called rarely.
   */
  private async teamIdForConversation(
    conversationId: string,
  ): Promise<string | null> {
    try {
      const row = await this.db.conversation.findUnique({
        where: { id: conversationId },
        select: { teamId: true },
      });
      return row?.teamId ?? null;
    } catch (err) {
      this.logger.error(`teamIdForConversation lookup failed: ${err}`);
      return null;
    }
  }

  /**
   * Emit a one-frame availability snapshot to a single socket on connect.
   * Reads every teammate's stored status (not just currently-connected — an
   * "Appear offline" user must still surface their status to teammates who
   * connect later). Tightly bounded query (one team only).
   */
  private async emitAvailabilitySnapshot(
    teamId: string,
    client: Socket,
  ): Promise<void> {
    let rows: {
      id: string;
      availabilityStatus: string | null;
      availabilityMessage: string | null;
    }[];
    try {
      rows = await this.db.user.findMany({
        where: { teamId, deactivatedAt: null },
        select: { id: true, availabilityStatus: true, availabilityMessage: true },
      });
    } catch (err) {
      // Fail-soft like the presence snapshot: a transient Postgres flap on
      // connect must not leak an unhandled rejection (this is invoked via
      // `void` on the connect path). Skip the seed frame — the client treats a
      // missing snapshot as "everyone available, no note", and the next status
      // flip or presence:request reseeds it.
      this.logger.error(`emitAvailabilitySnapshot lookup failed: ${err}`);
      return;
    }
    const byUserId: Record<
      string,
      { status: "available" | "busy" | "away" | "offline"; message?: string | null }
    > = {};
    for (const r of rows) {
      const status = (r.availabilityStatus ?? "available") as
        | "available"
        | "busy"
        | "away"
        | "offline";
      // Drop "available + no note" entries to keep the payload lean: the
      // client treats a missing entry as "available, no note" anyway.
      if (status === "available" && !r.availabilityMessage) continue;
      byUserId[r.id] = {
        status,
        ...(r.availabilityMessage !== null ? { message: r.availabilityMessage } : {}),
      };
    }
    client.emit("user:availability:snapshot", { teamId, byUserId });
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
          void this.buildVisibleViewers(conversationId, teamId).then(
            (viewerUserIds) => {
              this.server
                .to(conversationRoom(conversationId))
                .emit("conversation:viewers", {
                  conversationId,
                  viewerUserIds,
                });
            },
          );
        }
      }
      viewing.clear();
    }

    const wentOffline = this.presence.remove(teamId, userId, client.id);
    if (wentOffline) {
      // Async fire-and-forget — the DB read inside the snapshot helper isn't
      // worth blocking teardown on. A late frame on disconnect lands at most
      // a handful of ms behind, which is invisible to the team.
      void this.buildVisibleOnlineSnapshot(teamId)
        .then((onlineUserIds) => {
          this.server.to(teamRoom(teamId)).emit("presence:update", {
            teamId,
            onlineUserIds,
          });
        })
        .catch((err) =>
          // The helper itself is now fail-soft (falls back to the raw connected
          // set), so this only catches a truly unexpected throw — but a missing
          // .catch on a disconnect-path `void` is an unhandledRejection AND a
          // dropped went-offline frame, so keep the guard explicit.
          this.logger.error(`presence:update on disconnect failed: ${err}`),
        );
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
  async onPresenceRequest(@ConnectedSocket() client: Socket): Promise<void> {
    const teamId = client.data.teamId as string | undefined;
    if (!teamId) return;
    // Two DB reads per call (online snapshot + availability). Cheap, but
    // unbounded from a misbehaving client without a budget. Dedicated tiny
    // bucket (4/30s) — kept separate from the typing budget so a fast
    // typist burning typing tokens doesn't starve a legitimate reseed
    // (which is fired at most a few times per session).
    if (!checkPresenceRequestBudget(client)) return;
    const onlineUserIds = await this.buildVisibleOnlineSnapshot(teamId);
    client.emit("presence:update", { teamId, onlineUserIds });
    // Also reseed the availability snapshot — the hook re-fires presence:
    // request on every `connect`, and a reconnect after a long offline can
    // have missed availability changes that a delta can't carry.
    await this.emitAvailabilitySnapshot(teamId, client);
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
    const visibleViewers = await this.buildVisibleViewers(
      body.conversationId,
      teamId,
    );
    client.emit("conversation:viewers", {
      conversationId: body.conversationId,
      viewerUserIds: visibleViewers,
    });
    // Broadcast a fresh snapshot to the rest of the room only when this
    // user crossed 0→1 sockets. Multiple tabs from the same user must not
    // re-spam the team or the pill will flicker on every Caddy bounce.
    if (startedViewing) {
      this.server.to(room).emit("conversation:viewers", {
        conversationId: body.conversationId,
        viewerUserIds: visibleViewers,
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
        const teamId = client.data.teamId as string | undefined;
        if (!teamId) return;
        void this.buildVisibleViewers(body.conversationId, teamId).then(
          (viewerUserIds) => {
            this.server
              .to(conversationRoom(body.conversationId))
              .emit("conversation:viewers", {
                conversationId: body.conversationId,
                viewerUserIds,
              });
          },
        );
      }
    }
  }

  @SubscribeMessage("typing:start")
  onTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): void {
    if (!isValidBody(body, "conversationId")) return;
    if (!checkTypingBudget(client)) return;
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
    if (!checkTypingBudget(client)) return;
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
    const teamId = client.data.teamId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!teamId || !userId) return;
    const room = channelRoom(body.channelId);

    // Mirror the subscribe:conversation idempotency split: a re-subscribe
    // (the common reconnect path after socket.io's connectionStateRecovery
    // restored the room) skips the membership check + budget charge but
    // STILL re-emits the typing snapshot. Without the always-emit, a long
    // reconnect (past recovery window, suspended laptop) left the client
    // showing stale typing pills until the next change ticked.
    const alreadyJoined = client.rooms.has(room);

    if (!alreadyJoined) {
      if (!checkSubscribeBudget(client, "subscribe:channel")) return;
      try {
        // Membership check mirrors `requireChannelMembership` in
        // ChannelsService — default channels short-circuit; everyone else
        // must have a TeamChannelMember row. Silently no-op on failure
        // (don't teach a non-member that the channel exists).
        const channel = await this.db.teamChannel.findFirst({
          where: { id: body.channelId, teamId },
          select: { id: true, isDefault: true },
        });
        if (!channel) return;
        if (!channel.isDefault) {
          const member = await this.db.teamChannelMember.findUnique({
            where: { channelId_userId: { channelId: body.channelId, userId } },
            select: { userId: true },
          });
          if (!member) return;
        }
      } catch (err) {
        this.logger.error(`subscribe:channel lookup failed: ${err}`);
        return;
      }
      client.join(room);
    }

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
  // and reactions are all delivered through the CHANNEL room (membership-gated
  // at subscribe:channel) and filtered client-side by
  // `payload.threadRootId === rootMessageId`. A dedicated thread room would be
  // dead weight: every thread event source already targets the channel room
  // — which is also the privacy boundary keeping non-members from seeing the
  // content — so the gateway-level DB lookup a thread room would need buys
  // nothing.)

  @SubscribeMessage("typing:channel:start")
  onChannelTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): void {
    if (!isValidBody(body, "channelId")) return;
    if (!checkTypingBudget(client)) return;
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
    if (!checkTypingBudget(client)) return;
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
   *
   * Ownership check: the CLIENT supplies BOTH `channelId` and `threadRootId`,
   * and channel-room membership only proves the former. Without verifying the
   * thread root belongs to that channel, a member of channel A could inject
   * their userId into the typing indicator of a thread in private channel B
   * (which they aren't a member of) — same-team integrity spoofing. So the
   * FIRST toggle of a `(channelId, threadRootId)` composite confirms the root
   * message exists in that channel + team (mirrors subscribe:channel's
   * first-join pattern, charged against the same subscribe budget); validated
   * composites are cached on the socket so re-toggles skip the lookup.
   */
  @SubscribeMessage("typing:thread:start")
  async onThreadTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string; threadRootId: string },
  ): Promise<void> {
    if (!isValidBody(body, "channelId") || !isValidBody(body, "threadRootId")) return;
    if (!checkTypingBudget(client)) return;
    const userId = client.data.userId as string | undefined;
    const teamId = client.data.teamId as string | undefined;
    const typingInThread = client.data.typingInThread as Set<string> | undefined;
    const validatedThreads = client.data.validatedThreads as
      | Set<string>
      | undefined;
    if (!userId || !teamId || !typingInThread || !validatedThreads) return;
    if (!client.rooms.has(channelRoom(body.channelId))) return;
    const composite = `${body.channelId}::${body.threadRootId}`;
    // First registration of this composite → verify the thread root belongs
    // to the supplied channel before trusting it. Charged against the
    // subscribe budget (a DB roundtrip, same as subscribe:channel's first
    // join); a runaway client can't multiply Postgres load past that cap.
    if (!validatedThreads.has(composite)) {
      if (!checkSubscribeBudget(client, "typing:thread:start")) return;
      try {
        const root = await this.db.teamChannelMessage.findFirst({
          where: { id: body.threadRootId, channelId: body.channelId, teamId },
          select: { id: true },
        });
        if (!root) return; // silently drop — don't leak that the thread exists
      } catch (err) {
        this.logger.error(`typing:thread:start lookup failed: ${err}`);
        return;
      }
      validatedThreads.add(composite);
    }
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
    if (!checkTypingBudget(client)) return;
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

  /**
   * Force every live socket of `userId` to leave a channel room. Called by
   * `ChannelsService.removeMember` so a removed member's open tab stops
   * receiving live channel frames before they next reload. Channel events
   * are scoped to the channel room (see `fanout-rules.ts`), so leaving the
   * room is sufficient — no need to disconnect the socket entirely.
   */
  evictUserFromChannelRoom(userId: string, channelId: string): void {
    const room = channelRoom(channelId);
    const socketIds = this.presence.socketsFor(userId);
    for (const id of socketIds) {
      const s = this.server.sockets.sockets.get(id);
      if (s) s.leave(room);
    }
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

/**
 * Per-socket token bucket for typing toggles. Higher burst ceiling than
 * `subscribe:*` (a typist easily fires 4–6 toggle pairs a second) but still
 * bounded so a misbehaving / hostile client can't flood the conversation
 * room with `typing:update` frames. 60 tokens / 10s refill = ~6/sec average
 * with smoothing for legitimate bursts. Silent-drop matches
 * `checkSubscribeBudget` — the client's typing indicator skips a beat
 * instead of getting an error frame.
 */
const TYPING_CAP = 60;
const TYPING_REFILL_PER_MS = 60 / 10_000;
function checkTypingBudget(client: Socket): boolean {
  const now = Date.now();

  const data = client.data as any;
  let bucket = data.__typingBucket as { tokens: number; ts: number } | undefined;
  if (!bucket) {
    bucket = { tokens: TYPING_CAP, ts: now };
    data.__typingBucket = bucket;
  } else {
    bucket.tokens = Math.min(
      TYPING_CAP,
      bucket.tokens + (now - bucket.ts) * TYPING_REFILL_PER_MS,
    );
    bucket.ts = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * Dedicated tiny bucket for `presence:request`. Kept separate from the
 * typing bucket because they have different legitimate cadences: a typist
 * can burn 60 typing tokens in 10s during a long message, which would
 * leave a legitimate presence re-seed (fired on connect / reconnect)
 * empty for ~10s of refill.
 *
 * 8 tokens / 30s (bumped from 4 / 30s on 2026-05-29). The prior 4 was
 * tight enough that a shaky WiFi causing 5 reconnects in 30s on a single
 * tab silently dropped the 5th presence-snapshot request — presence dots
 * showed stale teammates until the next status flip. 8 still bounds a
 * hostile loop while accommodating reconnect-flap.
 */
const PRESENCE_REQUEST_CAP = 8;
const PRESENCE_REQUEST_REFILL_PER_MS = 8 / 30_000;
function checkPresenceRequestBudget(client: Socket): boolean {
  const now = Date.now();

  const data = client.data as any;
  let bucket = data.__presenceBucket as { tokens: number; ts: number } | undefined;
  if (!bucket) {
    bucket = { tokens: PRESENCE_REQUEST_CAP, ts: now };
    data.__presenceBucket = bucket;
  } else {
    bucket.tokens = Math.min(
      PRESENCE_REQUEST_CAP,
      bucket.tokens + (now - bucket.ts) * PRESENCE_REQUEST_REFILL_PER_MS,
    );
    bucket.ts = now;
  }
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
