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
import type { AvailabilitySource } from "@ccp/shared/work-hours";

import { invalidateWorkspaceSessionCache } from "../auth/session.guard";
import { DbService } from "../db/db.service";
import { getOnlineUserIds } from "@/lib/conversations/presence-bridge";
import {
  isRestrictedViewer,
  registerVisibilityInvalidator,
  visibilityWhere,
} from "@/lib/conversations/visibility";
import { PresenceService } from "./presence.service";
import { RealtimeEmitter, type TypedIO } from "./emitter.service";
import {
  channelRoom,
  conversationRoom,
  workspaceMetaRoom,
  workspaceRoom,
  userRoom,
} from "./rooms";
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
/** One team member's availability, as the three snapshot builders need it. */
interface TeamAvailabilityRow {
  id: string;
  availabilityStatus: string | null;
  availabilityMessage: string | null;
  /** "manual" | "admin" | "schedule" — who decided the status above. */
  availabilitySource: string | null;
  /** When a manual/admin pick hands back to the working-hours schedule. */
  availabilityOverrideUntil: Date | null;
}

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

  // Per-team monotonic presence-broadcast sequencing. Both the connect
  // (came-online) and disconnect (went-offline) paths build their team-wide
  // `presence:update` frame from an INDEPENDENT async DB read, so a rapid
  // connect→disconnect can resolve out of order and let an earlier
  // transition's frame overwrite a later one — leaving a departed agent
  // showing a stale green dot until the next presence event. Each transition
  // is stamped with a seq at mutation time (synchronous, before the await);
  // `broadcastPresence` drops any frame a newer transition already superseded.
  // Grow-only per team by design (team count is small — same posture as the
  // other in-process Maps).
  private readonly presenceSeq = new Map<string, number>();
  private readonly presenceEmittedSeq = new Map<string, number>();

  // Optional relay so agent typing in a conversation reaches a website-widget
  // visitor (bound by WebchatwidgetGateway at init). Called for EVERY
  // conversation's typing change; the relay emits to that conversation's widget
  // room, a no-op for non-webchatwidget threads — so no channel lookup here.
  private widgetTypingRelay: ((conversationId: string, on: boolean) => void) | null = null;
  bindWidgetTypingRelay(fn: (conversationId: string, on: boolean) => void): void {
    this.widgetTypingRelay = fn;
  }
  private relayWidgetTyping(conversationId: string): void {
    this.widgetTypingRelay?.(conversationId, this.typing.snapshotConv(conversationId).length > 0);
  }

  // Reverse direction: a website-widget visitor is typing → tell the agents.
  // Called by WebchatwidgetGateway when it receives a `visitor:typing` frame.
  // Emits to the agent conversation room only (same scope as `typing:update`).
  notifyVisitorTyping(conversationId: string, on: boolean): void {
    this.emitter.emitToConversation(conversationId, "conversation:visitor_typing", {
      conversationId,
      on,
    });
  }

  // A website visitor's socket connected/disconnected → tell the agents viewing
  // that conversation, so they can see whether the visitor is still there instead
  // of waiting on a dead thread. Called by WebchatwidgetGateway on connect/
  // disconnect. Ephemeral (like typing) — not persisted.
  //
  // The last-known state is ALSO cached here so an agent who opens the thread AFTER
  // the visitor connected (having missed the live frame) still gets seeded on
  // subscribe:conversation. Bounded: single process, ~30 orgs, short chats; a light
  // cap evicts the oldest offline entries so it can't grow without limit.
  private readonly visitorPresence = new Map<string, { present: boolean; leftAt: number | null }>();
  private static readonly VISITOR_PRESENCE_CAP = 5_000;

  /**
   * `reason` distinguishes the two ways a visitor stops being present, because
   * the inbox chip words them differently and both readings must be true:
   *   - "socket"     — the page closed/navigated. A real departure, so it carries
   *                    `leftAt` and renders "Left 3m ago".
   *   - "visibility" — the tab is backgrounded but the page is still open. They
   *                    have NOT left, so `leftAt` stays null and it renders the
   *                    plain "Away". Dating this would tell the agent someone
   *                    left when they are one tab away and may reply instantly.
   */
  notifyVisitorPresence(
    conversationId: string,
    present: boolean,
    reason: "socket" | "visibility" = "socket",
  ): void {
    const leftAt = present || reason === "visibility" ? null : Date.now();
    this.visitorPresence.set(conversationId, { present, leftAt });
    if (this.visitorPresence.size > RealtimeGateway.VISITOR_PRESENCE_CAP) this.evictPresence();
    this.emitter.emitToConversation(conversationId, "conversation:visitor_presence", {
      conversationId,
      present,
      leftAt,
    });
  }

  /** Drop offline entries (oldest leftAt first) once the map exceeds its cap — a
   *  currently-present visitor is always kept. */
  private evictPresence(): void {
    const offline = [...this.visitorPresence.entries()]
      .filter(([, v]) => !v.present)
      .sort((a, b) => (a[1].leftAt ?? 0) - (b[1].leftAt ?? 0));
    for (const [id] of offline) {
      if (this.visitorPresence.size <= RealtimeGateway.VISITOR_PRESENCE_CAP) break;
      this.visitorPresence.delete(id);
    }
  }

  // ── Agent availability → the widget ────────────────────────────────────────
  // The visitor's green dot should mean "an agent is reachable", not "my socket is
  // up". WebchatwidgetGateway binds a relay that pushes availability to that team's
  // visitor sockets; we call it whenever a team's presence flips (broadcastPresence),
  // so the dot updates live as agents come and go.
  private widgetAvailabilityRelay: ((workspaceId: string, online: boolean) => void) | null = null;
  bindWidgetAvailabilityRelay(fn: (workspaceId: string, online: boolean) => void): void {
    this.widgetAvailabilityRelay = fn;
  }
  private async relayWidgetAvailability(workspaceId: string): Promise<void> {
    if (!this.widgetAvailabilityRelay) return;
    this.widgetAvailabilityRelay(workspaceId, await this.teamHasAvailableAgent(workspaceId));
  }

  /**
   * True when ≥1 agent on the team is connected AND actually available.
   *
   * This dot is a PROMISE TO A CUSTOMER — "someone is here, ask your question" —
   * so it has to mean more than "a browser tab is open". A connected agent who
   * is busy, away, appear-offline, or outside their working hours is not going
   * to answer, and lighting the dot for them is a lie the visitor pays for in
   * waiting. Same `=== "available"` rule the "also viewing" pill uses, so the
   * two agent-reachability signals in the app can't disagree.
   *
   * Fail-soft on a DB error: fall back to raw presence (the old behavior).
   * Over-showing the dot for one tick beats going dark on transient Postgres
   * flapping — the visitor can still send, they just might wait.
   */
  async teamHasAvailableAgent(workspaceId: string): Promise<boolean> {
    const connected = getOnlineUserIds(workspaceId);
    if (!connected || connected.size === 0) return false;
    try {
      const rows = await this.teamAvailability(workspaceId);
      const available = new Set(
        rows
          .filter((r) => (r.availabilityStatus ?? "available") === "available")
          .map((r) => r.id),
      );
      for (const id of connected) if (available.has(id)) return true;
      return false;
    } catch (err) {
      this.logger.error(`teamHasAvailableAgent lookup failed: ${err}`);
      return true; // connected.size > 0 was already established
    }
  }

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
    // The ONLY caller of this is the `user.availability_changed` fanout, i.e.
    // the exact moment the cached availability rows went stale. Busting the
    // cache here means the TTL never delays a real status change — it only
    // ever collapses reads that nothing invalidated (the reconnect storm).
    this.emitter.bindPresenceSnapshotter((workspaceId) => {
      this.invalidateTeamAvailability(workspaceId);
      // An availability change can flip the widget's "an agent is available"
      // dot too — a lone agent going busy/away, or the working-hours sweeper
      // closing the shift, means nobody is there to answer a visitor. Before
      // this, the relay only fired on socket connect/disconnect, so the dot
      // stayed green after the last agent marked themselves away (or went off
      // shift) until someone happened to open or close a tab.
      void this.relayWidgetAvailability(workspaceId);
      return this.buildVisibleOnlineSnapshot(workspaceId);
    });
    // Same indirection for the per-conversation viewer pill — the
    // `user.availability_changed` fanout re-emits `conversation:viewers`
    // for every room the user is in so a status flip drops/restores them
    // from teammates' "also viewing" pills in the same frame as the badge.
    this.emitter.bindConversationViewersSnapshotter(async (conversationId) => {
      const workspaceId = await this.teamIdForConversation(conversationId);
      if (workspaceId === null) return null;
      return {
        workspaceId,
        viewerUserIds: await this.buildVisibleViewers(conversationId, workspaceId),
      };
    });
    this.emitter.bindConversationsViewedByUser((userId) =>
      this.presence.conversationsViewedBy(userId),
    );
    // RT-1: resolve a channel's activity-badge audience. Default channel →
    // whole team; membership-gated channel → just its members (their user
    // rooms), so a private channel's activity never reaches non-members.
    this.emitter.bindChannelActivityResolver(async (channelId, workspaceId) => {
      const channel = await this.db.teamChannel.findFirst({
        where: { id: channelId, workspaceId },
        select: { isDefault: true, members: { select: { userId: true } } },
      });
      if (!channel) return { isDefault: false, memberUserIds: [] };
      return {
        isDefault: channel.isDefault,
        memberUserIds: channel.members.map((m) => m.userId),
      };
    });

    // Agent conversation-visibility fanout resolvers. Bound here (rather than
    // importing Prisma into the emitter) exactly like the channel-activity
    // resolver above. All three reads are single-row and indexed, and the
    // emitter caches them, so an opted-in team pays a lookup per conversation
    // per 30s — not per frame.
    this.emitter.bindVisibilityResolvers(
      async (workspaceId) => {
        const team = await this.db.workspace.findUnique({
          where: { id: workspaceId },
          select: { agentConversationVisibility: true },
        });
        return team?.agentConversationVisibility === "assigned";
      },
      async (conversationId) => {
        const conv = await this.db.conversation.findUnique({
          where: { id: conversationId },
          select: { assignedUserId: true },
        });
        return conv?.assignedUserId ?? null;
      },
    );

    // When an admin flips the workspace's agent-visibility setting, revoke in
    // strict order — each step exists to make the NEXT one safe:
    //  1. Bust the HTTP/handshake session caches for the whole workspace.
    //     Room membership and `socket.data.agentConversationVisibility` are
    //     fixed at handshake, and the forced re-handshake below reads the
    //     session-cache fast paths — a stale entry would hand the reconnected
    //     socket its PRE-flip visibility (rejoining the ws: firehose) for the
    //     socket's whole lifetime.
    //  2. Bust the emitter's per-team scope cache so fanout switches audience
    //     on the next frame.
    //  3. Queue the catalog tick BEFORE the disconnect packet: both ride the
    //     same ordered transport, so every tab receives the tick (a
    //     router.refresh() that re-derives the RSC's restricted flag against
    //     the now-busted cache), then the drop. wsmeta so restricted agents
    //     get it too.
    //  4. Disconnect LAST. All four steps are synchronous, so a re-handshake
    //     can only ever read post-bust state.
    registerVisibilityInvalidator((workspaceId) => {
      invalidateWorkspaceSessionCache(workspaceId);
      this.emitter.invalidateWorkspaceScope(workspaceId);
      this.emitter.emitToWorkspaceMeta(workspaceId, "team:catalog:changed", {
        workspaceId,
        scope: "members",
      });
      this.disconnectWorkspaceSockets(workspaceId);
      // A handshake that read the cache pre-bust but registered after the
      // disconnect loop survives with stale identity (sub-millisecond race —
      // same one SessionInvalidationService.revoke documents). One delayed
      // second sweep closes it; post-bust reconnects get bounced once more,
      // which is harmless (they re-handshake against fresh caches).
      setTimeout(() => this.disconnectWorkspaceSockets(workspaceId), 1_000).unref?.();
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
      // I-7: key on the TRUSTED client IP. The leftmost X-Forwarded-For entry is
      // client-PREPENDABLE — an attacker can send a fresh random first value per
      // handshake to land in a brand-new bucket every time and never trip the
      // cap. Prod Caddy sets `header_up X-Real-IP {remote_host}` (it OVERWRITES
      // any client-supplied value with the real peer), so X-Real-IP is
      // unspoofable behind the proxy. Fall back to the direct socket peer address
      // for the no-proxy (host dev) case. We deliberately do NOT consult
      // X-Forwarded-For here — its first entry is the spoofable one.
      const ip =
        (socket.handshake.headers["x-real-ip"] as string | undefined)?.trim() ||
        socket.handshake.address ||
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
        // Re-insert so the Map's iteration order is LEAST-RECENTLY-USED first,
        // which is what the eviction above assumes. Without it, eviction took
        // the oldest-INSERTED key — typically the long-lived office NAT — and
        // its replacement bucket started at the full cap, refunding whatever
        // budget the caller had spent.
        handshakeBuckets.delete(ip);
        handshakeBuckets.set(ip, bucket);
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
        socket.data.workspaceId = result.identity.workspaceId;
        socket.data.role = result.identity.role;
        // Decides team-firehose room membership on connect (see
        // handleConnection). Stashed here so a recovered reconnect that skips
        // the DB read still carries the boundary.
        socket.data.agentConversationVisibility =
          result.identity.agentConversationVisibility;
        // OPERATOR MODE (see SocketIdentity.isOperator). Stashed alongside the
        // rest of the identity so every handler that could ANNOUNCE this socket
        // to the workspace can check it without a lookup.
        socket.data.isOperator = result.identity.isOperator;
        return next();
      }
      if (result.kind === "unavailable") {
        // Auth backend degraded — instruct the client to reconnect rather
        // than navigate to /logout. The browser's connect_error handler
        // distinguishes this string from "unauthenticated".
        return next(new Error("auth_unavailable"));
      }
      if (result.kind === "gated") {
        // Session is VALID but the app is gating them (org pending/suspended,
        // or email unverified). The socket still refuses to connect — no
        // realtime data flows — but the client must NOT navigate to /logout,
        // because that deletes a perfectly good session and lands them on a
        // context-free /login instead of the /pending screen that explains the
        // suspension (with its reason) or the /verify screen that unblocks
        // them. See SocketAuthResult["gated"].
        return next(new Error("session_gated"));
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
    const workspaceId = client.data.workspaceId as string | undefined;
    const role = client.data.role as Role | undefined;
    if (!userId || !workspaceId || !role) {
      client.disconnect(true);
      return;
    }
    const agentConversationVisibility =
      (client.data.agentConversationVisibility as string | undefined) ?? "team";
    // OPERATOR MODE. The auth middleware sets this in the same assignment as
    // userId/workspaceId/role, and the guard above already drops a socket
    // missing any of those — so this is never independently absent.
    const isOperator = client.data.isOperator === true;
    const identity = { userId, workspaceId, role, agentConversationVisibility };

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
    //
    // EXCEPT under agent conversation-visibility scoping: a restricted agent
    // must NOT be in the team firehose, because that room carries message
    // bodies, contact PII and note text for the whole org. Enforcing this by
    // ROOM MEMBERSHIP rather than by filtering at emit time is deliberate —
    // membership is one decision made once per connection, whereas an emit
    // filter has to be remembered at every one of ~30 fanout rules and will
    // eventually be missed. A restricted agent still receives everything about
    // their OWN conversations via their `user:` room, which every
    // conversation-scoped rule co-targets.
    const restrictedViewer = isRestrictedViewer({
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      role: identity.role,
      agentConversationVisibility: identity.agentConversationVisibility,
    });
    if (!restrictedViewer) {
      client.join(workspaceRoom(identity.workspaceId));
    } else {
      // connectionStateRecovery restores a socket's previous rooms with no
      // handler run. If the workspace flipped to "assigned" while this agent
      // was inside the recovery window, the restored `ws:` membership must be
      // revoked here — auth re-ran (middlewares are not skipped) and read the
      // post-flip setting, but the adapter silently re-added the old room.
      // No-op on a fresh connect.
      client.leave(workspaceRoom(identity.workspaceId));
    }
    // Workspace-METADATA room: unconditional — restricted agents included.
    // Carries content-free workspace signals (catalog ticks, presence,
    // availability, directory updates, broadcast progress); see rooms.ts.
    client.join(workspaceMetaRoom(identity.workspaceId));
    // Per-user room (RT-1) — lets the server target this user across all their
    // tabs for membership-scoped fanout (private-channel activity badges)
    // without a team-wide broadcast that leaks metadata to non-members.
    client.join(userRoom(identity.workspaceId, identity.userId));

    // connectionStateRecovery re-joins this socket's previous rooms with no
    // handler involved, so a membership revoked while it was disconnected was
    // never enforced. Re-validate the restored channel rooms immediately
    // rather than waiting for the client to re-subscribe (which it may never
    // do — a backgrounded tab just keeps receiving). Detached: a slow DB read
    // must not hold up the connect path.
    if (client.recovered) {
      void this.pruneRecoveredConversationRooms(client, identity).catch(
        (err: unknown) =>
          this.logger.error(`pruneRecoveredConversationRooms failed: ${err}`),
      );
      void this.pruneRecoveredChannelRooms(client, identity.workspaceId, identity.userId).catch(
        (err) =>
          this.logger.error(`pruneRecoveredChannelRooms failed: ${err}`),
      );
    }

    // STEALTH GATE (operator mode). The platform operator watching a tenant's
    // workspace must not light a green dot on that team's sidebar. NOT
    // REGISTERING is the mechanism, not filtering at emit time: `presence.add`
    // also feeds `PresenceService`'s online set, which the assignment
    // round-robin consults to prefer online agents — an operator in that set
    // could be preferred for real customer work they cannot even be assigned.
    // Absent from the set, both leaks are structurally impossible.
    const cameOnline = isOperator
      ? false
      : this.presence.add(identity.workspaceId, identity.userId, client.id);
    // Stamp the transition synchronously (before the async snapshot build) so
    // ordering is preserved against a racing disconnect — see `presenceSeq`.
    const presenceSeq = cameOnline
      ? this.nextPresenceSeq(identity.workspaceId)
      : null;
    // Visibly-online snapshot — connected users intersected with "not marked
    // offline" so an agent who picked "Appear offline" doesn't show up on
    // teammates' green dots even though their socket is connected. The async
    // DB read happens at most once per connect (rare); after that the gateway
    // handles user.availability_changed via the fanout's emitPresenceSnapshot
    // path, not on every emit.
    const onlineUserIds = await this.buildVisibleOnlineSnapshot(identity.workspaceId);
    // Snapshot to THIS socket immediately so the user's own dot lights up
    // without waiting for the next presence change.
    client.emit("presence:update", {
      workspaceId: identity.workspaceId,
      onlineUserIds,
    });
    // Seed availability for every teammate in one frame so the freshly-loaded
    // tab paints right immediately, without waiting for a teammate to change
    // status. Reuses the same DB read that built the presence snapshot
    // shape-wise — kept as separate frames so consumers can subscribe to
    // either independently (presence and availability are orthogonal).
    void this.emitAvailabilitySnapshot(identity.workspaceId, client).catch((err) =>
      this.logger.error(`emitAvailabilitySnapshot (connect) failed: ${err}`),
    );
    // Standing "who is looking at what" for the inbox list's per-row eye. Only
    // for a socket that is in the workspace room — the frame names conversations
    // across the whole inbox, which is exactly what a restricted agent must not
    // receive (they see the eye on the thread they opened, from the `conv:`
    // frame their own subscribe emits).
    if (!restrictedViewer) {
      void this.emitViewersSnapshot(identity.workspaceId, client).catch((err) =>
        this.logger.error(`emitViewersSnapshot (connect) failed: ${err}`),
      );
    }
    // Broadcast a fresh snapshot to the rest of the team ONLY when this
    // connect transitioned the user from 0→1 sockets. Without the gate
    // every additional tab / Caddy bounce reconnect spammed a team-wide
    // emit even though the onlineUserIds list didn't change.
    if (presenceSeq !== null) {
      this.broadcastPresence(identity.workspaceId, presenceSeq, onlineUserIds);
    }
  }

  /**
   * Drop any `chan:` room a recovered socket was re-joined to that its user is
   * no longer entitled to. See the call site in `handleConnection` for why
   * recovery makes this necessary; `subscribe:channel` enforces the same rule
   * on the client-driven path.
   *
   * One query for the channels, one for the memberships — not per room.
   */
  /**
   * Drop any `conv:` room a recovered socket was re-joined to that its user
   * may no longer see. connectionStateRecovery restores room membership with
   * NO handler running, so without this a thread reassigned away from a
   * restricted agent while their laptop slept stayed subscribed — typing,
   * viewers, message status, and broadcast message bodies included. Mirrors
   * `pruneRecoveredChannelRooms`; one batched query for all recovered rooms.
   */
  private async pruneRecoveredConversationRooms(
    client: Socket,
    identity: { workspaceId: string; userId: string },
  ): Promise<void> {
    const conversationIds: string[] = [];
    for (const room of client.rooms) {
      if (room.startsWith("conv:")) conversationIds.push(room.slice("conv:".length));
    }
    if (conversationIds.length === 0) return;

    const visible = await this.db.conversation.findMany({
      where: {
        id: { in: conversationIds },
        workspaceId: identity.workspaceId,
        ...visibilityWhere({
          userId: identity.userId,
          workspaceId: identity.workspaceId,
          role: client.data.role as Role,
          agentConversationVisibility: client.data.agentConversationVisibility as
            | string
            | undefined,
        }),
      },
      select: { id: true },
    });
    const allowed = new Set(visible.map((c) => c.id));
    for (const conversationId of conversationIds) {
      if (!allowed.has(conversationId)) {
        client.leave(conversationRoom(conversationId));
        this.logger.warn(
          `pruned recovered socket ${client.id} from conv:${conversationId} (user ${identity.userId} no longer visible)`,
        );
      }
    }
  }

  private async pruneRecoveredChannelRooms(
    client: Socket,
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const channelIds: string[] = [];
    for (const room of client.rooms) {
      if (room.startsWith("chan:")) channelIds.push(room.slice("chan:".length));
    }
    if (channelIds.length === 0) return;

    const [channels, memberships] = await Promise.all([
      this.db.teamChannel.findMany({
        where: { id: { in: channelIds }, workspaceId },
        select: { id: true, isDefault: true },
      }),
      this.db.teamChannelMember.findMany({
        where: { channelId: { in: channelIds }, userId },
        select: { channelId: true },
      }),
    ]);
    const memberOf = new Set(memberships.map((m) => m.channelId));
    const defaults = new Set(
      channels.filter((c) => c.isDefault).map((c) => c.id),
    );
    // A channel that no longer exists (or belongs to another team) is not in
    // `channels` at all — that also fails the check, which is what we want.
    const visible = new Set(channels.map((c) => c.id));

    for (const channelId of channelIds) {
      const allowed =
        visible.has(channelId) &&
        (defaults.has(channelId) || memberOf.has(channelId));
      if (!allowed) {
        client.leave(channelRoom(channelId));
        this.logger.warn(
          `pruned recovered socket ${client.id} from chan:${channelId} (user ${userId} not a member)`,
        );
      }
    }
  }

  /**
   * Per-team availability rows, cached for a few seconds.
   *
   * WHY THIS EXISTS. Three call sites here (`buildVisibleOnlineSnapshot`,
   * `emitAvailabilitySnapshot`, `buildVisibleViewers`) each ran their own
   * `user.findMany` per invocation, and the comment above the first one
   * justified that with "presence snapshots are rare events (connect / status
   * flip), not per-message". That is true of ONE agent's connect. It is false
   * of the whole fleet's:
   *
   *   - `drainSockets()` on SIGTERM now disconnects every socket deliberately,
   *     so a deploy makes the entire fleet reconnect within a few seconds
   *     instead of trickling back. The reconnect storm is now synchronized BY
   *     DESIGN, which is good for recovery time and turns this into a spike.
   *   - `use-presence.ts` re-fires `presence:request` on every `connect`, and
   *     that handler re-runs both reads again.
   *
   * At a 500-user tenant with two tabs each that is ~4000 queries in a burst,
   * half of them returning all 500 team rows. That saturates the Prisma pool
   * shared with inbox REST and webhook ingest — and both readers are fail-soft
   * (they fall back to an unfiltered set on error), so the visible symptom is
   * wrong presence dots and a slow inbox rather than an obvious failure.
   *
   * A few seconds of staleness is the right trade here: presence is an
   * ambient signal, every status change still pushes an immediate delta frame
   * to already-connected clients, and a stale read self-corrects on the next
   * transition. The in-flight promise is shared so a thundering herd collapses
   * to ONE query per team rather than one per socket.
   *
   * STALENESS IS BOUNDED TO WHAT IT SHOULD BE. The only write path to
   * `availabilityStatus` is `UserAvailabilityService.updateMyAvailability`, which
   * publishes `user.availability_changed`; that fanout calls
   * `emitPresenceSnapshot`, which busts this cache first (see `afterInit`). So
   * a status flip is never delayed. The one case the TTL does cover is
   * DEACTIVATION — a user deactivated in the last 3s can still appear in a
   * teammate's availability list, which is cosmetic, self-correcting, and
   * independent of the socket-disconnect path deactivation already triggers.
   */
  private static readonly AVAILABILITY_TTL_MS = 3_000;
  private readonly availabilityCache = new Map<
    string,
    { at: number; rows: TeamAvailabilityRow[] }
  >();
  private readonly availabilityInFlight = new Map<
    string,
    Promise<TeamAvailabilityRow[]>
  >();

  /**
   * Team availability rows, served from cache when fresh. Throws on a DB
   * failure — every caller already has its own fail-soft fallback and they
   * differ, so this must not pick one for them.
   */
  private async teamAvailability(workspaceId: string): Promise<TeamAvailabilityRow[]> {
    const hit = this.availabilityCache.get(workspaceId);
    if (hit && Date.now() - hit.at < RealtimeGateway.AVAILABILITY_TTL_MS) {
      return hit.rows;
    }
    const inFlight = this.availabilityInFlight.get(workspaceId);
    if (inFlight) return inFlight;

    // One entry per team, so this is tiny at pilot scale — but sweep expired
    // entries past a threshold rather than adding another grow-only map to
    // the pile the §16 cliff already has to clean up.
    if (this.availabilityCache.size > 200) {
      const cutoff = Date.now() - RealtimeGateway.AVAILABILITY_TTL_MS;
      for (const [k, v] of this.availabilityCache) {
        if (v.at < cutoff) this.availabilityCache.delete(k);
      }
    }

    const p = this.db.user
      .findMany({
        // Membership is `WorkspaceMember` since the tenancy restructure —
        // `User.workspaceId` no longer exists. Filtering on it threw a
        // PrismaClientValidationError on EVERY socket connect, so no teammate
        // ever received the availability seed frame.
        where: { workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
        select: {
          id: true,
          availabilityStatus: true,
          availabilityMessage: true,
          availabilitySource: true,
          availabilityOverrideUntil: true,
        },
      })
      .then((rows) => {
        this.availabilityCache.set(workspaceId, { at: Date.now(), rows });
        return rows;
      })
      .finally(() => {
        this.availabilityInFlight.delete(workspaceId);
      });
    this.availabilityInFlight.set(workspaceId, p);
    return p;
  }

  /**
   * Drop a team's cached availability so the next read is fresh. Called when a
   * status actually changes, so the TTL only ever delays a read that nothing
   * invalidated — a flip is reflected immediately, not up to 3s later.
   */
  invalidateTeamAvailability(workspaceId: string): void {
    this.availabilityCache.delete(workspaceId);
    // Drop the IN-FLIGHT promise too, not just the cached value. A query
    // already running was issued BEFORE the status write committed, so
    // handing it to the next caller serves pre-change data — and its `.then`
    // would then cache that stale row set for the full TTL.
    //
    // This is reachable exactly when it hurts most: during the deploy
    // reconnect storm that `drainSockets()` now makes synchronized by design,
    // agent A's connect starts a query, user X toggles "Appear offline"
    // mid-flight, and the fanout's snapshot rebuild joins A's stale query. X
    // would keep showing as online — and in teammates' "also viewing" pills,
    // since buildVisibleViewers reads the same cache — until the next
    // transition. The doc above promises a status flip is never delayed by the
    // TTL; this is what makes that true.
    this.availabilityInFlight.delete(workspaceId);
  }

  /**
   * Compute the team's visibly-online userIds: presence (≥1 socket) intersected
   * with `availabilityStatus !== "offline"`.
   */
  /**
   * Stamp a presence transition with the next per-team seq (synchronous — must
   * be called at the same tick as the presence add/remove so it captures true
   * temporal order before any async snapshot build).
   */
  private nextPresenceSeq(workspaceId: string): number {
    const next = (this.presenceSeq.get(workspaceId) ?? 0) + 1;
    this.presenceSeq.set(workspaceId, next);
    return next;
  }

  /**
   * Emit a team-wide `presence:update`, but only if a newer transition hasn't
   * already reached the wire. Guards against the connect/disconnect DB reads
   * resolving out of order (see `presenceSeq` above).
   */
  private broadcastPresence(
    workspaceId: string,
    seq: number,
    onlineUserIds: string[],
  ): void {
    if (seq < (this.presenceEmittedSeq.get(workspaceId) ?? 0)) return;
    this.presenceEmittedSeq.set(workspaceId, seq);
    // Meta room, not ws: — presence dots are directory metadata every member
    // (restricted agents included) renders in the sidebar.
    this.server.to(workspaceMetaRoom(workspaceId)).emit("presence:update", {
      workspaceId,
      onlineUserIds,
    });
    // Keep the widget's "an agent is available" dot in step with real presence.
    void this.relayWidgetAvailability(workspaceId);
  }

  private async buildVisibleOnlineSnapshot(workspaceId: string): Promise<string[]> {
    const connected = this.presence.snapshot(workspaceId);
    if (connected.length === 0) return [];
    try {
      // Intersect the LIVE presence set against cached availability, rather
      // than caching the intersection: a reconnect storm changes `connected`
      // every few milliseconds, so a cached result would be wrong, while a
      // cached "who is marked offline" is exactly as fresh as it needs to be.
      // A user absent from the rows (deactivated) is not in `offline`, so they
      // stay in the list — identical to the previous per-connected-id query.
      const rows = await this.teamAvailability(workspaceId);
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
    workspaceId: string,
  ): Promise<string[]> {
    const viewers = this.presence.snapshotViewers(conversationId);
    if (viewers.length === 0) return [];
    try {
      const rows = await this.teamAvailability(workspaceId);
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
   * Emit a conversation's viewer set to BOTH rooms that need it:
   *
   *   - `conv:<id>` — the thread header of everyone with it open.
   *   - `team:<id>` — the inbox LIST, which paints an eye on the row of every
   *     thread a teammate is reading. The list can't subscribe to a room per
   *     row, so the workspace room is the only place this can land.
   *
   * Frequency is one frame per open/close of a chat (per user, gated on the
   * user-level 0↔1 transition), not per keystroke — the same budget the
   * team-room presence frames already run on. Restricted agents are not in the
   * workspace room, so they receive only the `conv:` copy for threads they
   * actually opened.
   *
   * ONE emitter for all four call sites (subscribe / unsubscribe / disconnect /
   * availability re-emit) so a fifth can't quietly ship with half the fanout.
   */
  private emitViewers(
    conversationId: string,
    workspaceId: string,
    viewerUserIds: string[],
  ): void {
    const payload = { conversationId, viewerUserIds };
    this.server.to(conversationRoom(conversationId)).emit("conversation:viewers", payload);
    this.server.to(workspaceRoom(workspaceId)).emit("conversation:viewers", payload);
  }

  /**
   * One-shot "who is looking at what" for a whole workspace, to THIS socket.
   * The per-conversation frames are deltas; without this a tab that connects
   * mid-shift shows no eyes until a teammate next opens or closes something.
   *
   * One cached availability read filters every conversation, so the cost is
   * the same as a single `buildVisibleViewers` regardless of how many threads
   * are open across the team.
   */
  private async emitViewersSnapshot(
    workspaceId: string,
    client: Socket,
  ): Promise<void> {
    const raw = this.presence.viewersByWorkspace(workspaceId);
    if (raw.length === 0) {
      client.emit("conversation:viewers_snapshot", { workspaceId, viewers: [] });
      return;
    }
    let available: Set<string> | null = null;
    try {
      const rows = await this.teamAvailability(workspaceId);
      available = new Set(
        rows
          .filter((r) => (r.availabilityStatus ?? "available") === "available")
          .map((r) => r.id),
      );
    } catch (err) {
      // Same fail-soft posture as buildVisibleViewers — an over-inclusive eye
      // beats a blank list under transient Postgres flapping.
      this.logger.error(`emitViewersSnapshot availability lookup failed: ${err}`);
    }
    const viewers = raw
      .map((entry) => ({
        conversationId: entry.conversationId,
        viewerUserIds: available
          ? entry.viewerUserIds.filter((id) => available.has(id))
          : entry.viewerUserIds,
      }))
      .filter((entry) => entry.viewerUserIds.length > 0);
    client.emit("conversation:viewers_snapshot", { workspaceId, viewers });
  }

  /**
   * Resolve the workspaceId for a conversation room. Used by the viewers
   * snapshotter so the cross-event re-emit (on availability flip) can
   * filter by the right team. Cheap indexed read; called rarely.
   */
  private async teamIdForConversation(
    conversationId: string,
  ): Promise<string | null> {
    try {
      const row = await this.db.conversation.findUnique({
        where: { id: conversationId },
        select: { workspaceId: true },
      });
      return row?.workspaceId ?? null;
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
    workspaceId: string,
    client: Socket,
  ): Promise<void> {
    let rows: TeamAvailabilityRow[];
    try {
      rows = await this.teamAvailability(workspaceId);
    } catch (err) {
      // Fail-soft like the presence snapshot: a transient Postgres flap on
      // connect must not leak an unhandled rejection (this is invoked via
      // `void` on the connect path). Skip the seed frame — the client treats a
      // missing snapshot as "everyone available, no note", and the next status
      // flip or presence:request reseeds it.
      this.logger.error(`emitAvailabilitySnapshot lookup failed: ${err}`);
      return;
    }
    const viewerUserId = client.data.userId as string | undefined;
    const byUserId: Record<
      string,
      {
        status: "available" | "busy" | "away" | "offline";
        message?: string | null;
        source?: AvailabilitySource;
        until?: string | null;
      }
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
        // Provenance rides along so a reconnecting tab can render "set by an
        // admin" / "outside working hours" without a follow-up REST call.
        ...(r.availabilitySource && r.availabilitySource !== "manual"
          ? { source: r.availabilitySource as AvailabilitySource }
          : {}),
        // `until` is OWN-ROOM ONLY, exactly as the `user.availability_changed`
        // fanout rule builds it: the team frame carries no `until`, so
        // shipping it here for teammates gave the snapshot a field no live
        // frame ever refreshes — visible until the next reconnect and past
        // the boundary the fanout states.
        ...(r.id === viewerUserId && r.availabilityOverrideUntil
          ? { until: r.availabilityOverrideUntil.toISOString() }
          : {}),
      };
    }
    client.emit("user:availability:snapshot", { workspaceId, byUserId });
  }

  handleDisconnect(client: Socket): void {
    const workspaceId = client.data.workspaceId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!workspaceId || !userId) return;

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
        this.relayWidgetTyping(conversationId);
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
          void this.buildVisibleViewers(conversationId, workspaceId).then(
            (viewerUserIds) => {
              this.emitViewers(conversationId, workspaceId, viewerUserIds);
            },
          );
        }
      }
      viewing.clear();
    }

    const wentOffline = this.presence.remove(workspaceId, userId, client.id);
    if (wentOffline) {
      // Stamp the transition synchronously so a racing connect can't overtake
      // this went-offline frame with a stale user-online one (see presenceSeq).
      const seq = this.nextPresenceSeq(workspaceId);
      // Async fire-and-forget — the DB read inside the snapshot helper isn't
      // worth blocking teardown on. A late frame on disconnect lands at most
      // a handful of ms behind, which is invisible to the team.
      void this.buildVisibleOnlineSnapshot(workspaceId)
        .then((onlineUserIds) => {
          this.broadcastPresence(workspaceId, seq, onlineUserIds);
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
    const workspaceId = client.data.workspaceId as string | undefined;
    if (!workspaceId) return;
    // Two DB reads per call (online snapshot + availability). Cheap, but
    // unbounded from a misbehaving client without a budget. Dedicated tiny
    // bucket (4/30s) — kept separate from the typing budget so a fast
    // typist burning typing tokens doesn't starve a legitimate reseed
    // (which is fired at most a few times per session).
    if (!checkPresenceRequestBudget(client)) return;
    const onlineUserIds = await this.buildVisibleOnlineSnapshot(workspaceId);
    client.emit("presence:update", { workspaceId, onlineUserIds });
    // Also reseed the availability snapshot — the hook re-fires presence:
    // request on every `connect`, and a reconnect after a long offline can
    // have missed availability changes that a delta can't carry.
    await this.emitAvailabilitySnapshot(workspaceId, client);
  }

  /**
   * Pull-style viewers snapshot — the inbox list's counterpart to
   * `presence:request`, and fired by the same hook on every `connect`. The
   * connect-time push happens before any feature hook has mounted a listener,
   * so a route-nav into /inbox needs to ask.
   *
   * Gated on workspace-room membership: a restricted agent never receives a
   * frame naming conversations outside their own, whether pushed or pulled.
   */
  @SubscribeMessage("viewers:request")
  async onViewersRequest(@ConnectedSocket() client: Socket): Promise<void> {
    const workspaceId = client.data.workspaceId as string | undefined;
    if (!workspaceId) return;
    if (!client.rooms.has(workspaceRoom(workspaceId))) return;
    if (!checkPresenceRequestBudget(client, "__viewersBucket")) return;
    await this.emitViewersSnapshot(workspaceId, client);
  }

  // ---- conversation rooms -------------------------------------------------
  @SubscribeMessage("subscribe:conversation")
  async onSubscribeConversation(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): Promise<void> {
    if (!isValidBody(body, "conversationId")) return;
    const workspaceId = client.data.workspaceId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!workspaceId || !userId) return;
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

    // Charge the rate-limit budget ONLY on the first-join path (which also
    // team-broadcasts below). A re-subscribe MUST always reach the snapshot
    // re-emit — otherwise a team-wide reconnect storm could exhaust the shared
    // subscribe bucket and silently drop the typing/viewer snapshot on the
    // displayed thread, the exact desync the always-emit design exists to
    // prevent.
    if (!alreadyJoined && !checkSubscribeBudget(client, "subscribe:conversation")) return;
    try {
      // Ownership gate — on EVERY subscribe, not just first join. Team scope
      // defends against cross-tenant id-guessing; the visibility clause
      // additionally stops a RESTRICTED agent from joining a thread that isn't
      // theirs. The alreadyJoined path used to skip this entirely — exactly
      // the recovery hole subscribe:channel fixed for itself: connection-
      // StateRecovery restores room membership with no handler, so a thread
      // reassigned away from a restricted agent mid-sleep stayed subscribed
      // (typing, viewers, message status, and broadcast message BODIES).
      const owns = await this.db.conversation.findFirst({
        where: {
          id: body.conversationId,
          workspaceId,
          ...visibilityWhere({
            userId: client.data.userId as string,
            workspaceId,
            role: client.data.role as Role,
            agentConversationVisibility: client.data
              .agentConversationVisibility as string | undefined,
          }),
        },
        select: { id: true, channel: true },
      });
      if (!owns) {
        // No longer (or never) theirs. A stale recovered membership is
        // actively revoked, not just left unrefreshed.
        if (alreadyJoined) client.leave(room);
        return; // silently drop — fail-soft posture
      }
      if (!alreadyJoined) client.join(room);
      // Seed website-widget visitor presence to THIS agent — on re-subscribe
      // too: the live frame only fires on the visitor's connect/disconnect, so
      // a recovered socket parked on a widget thread would otherwise show a
      // stale Online/Left chip until the visitor's next transition.
      if (owns.channel === "webchatwidget") {
        const p = this.visitorPresence.get(body.conversationId);
        client.emit("conversation:visitor_presence", {
          conversationId: body.conversationId,
          present: p?.present ?? false,
          leftAt: p?.present ? null : p?.leftAt ?? null,
        });
      }
    } catch (err) {
      this.logger.error(`subscribe:conversation lookup failed: ${err}`);
      return;
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
    //
    // STEALTH GATE (operator mode): the operator is never REGISTERED as a
    // viewer, so no "also viewing" eye appears on the tenant's inbox row and
    // none can appear later — `buildVisibleViewers` is fail-soft and falls back
    // to the RAW viewer set when its availability lookup throws, so filtering
    // at emit time would still flash the operator's id on a DB blip. They keep
    // receiving the snapshot below: the operator sees who else is looking, the
    // team never sees the operator. `viewingConversations` is likewise not
    // populated, which keeps disconnect's release loop a no-op for them.
    const isOperator = client.data.isOperator === true;
    const viewing = client.data.viewingConversations as Set<string>;
    if (!isOperator) viewing.add(body.conversationId);
    const startedViewing = isOperator
      ? false
      : this.presence.addViewer(body.conversationId, userId, client.id, workspaceId);
    // Snapshot to THIS socket immediately so the pill paints without
    // waiting for the next change — same posture as team presence. Fires
    // on every (re-)subscribe so a long reconnect catches a fresh snapshot.
    const visibleViewers = await this.buildVisibleViewers(
      body.conversationId,
      workspaceId,
    );
    client.emit("conversation:viewers", {
      conversationId: body.conversationId,
      viewerUserIds: visibleViewers,
    });
    // Broadcast a fresh snapshot to the rest of the room only when this
    // user crossed 0→1 sockets. Multiple tabs from the same user must not
    // re-spam the team or the pill will flicker on every Caddy bounce.
    if (startedViewing) {
      this.emitViewers(body.conversationId, workspaceId, visibleViewers);
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
        const workspaceId = client.data.workspaceId as string | undefined;
        if (!workspaceId) return;
        void this.buildVisibleViewers(body.conversationId, workspaceId).then(
          (viewerUserIds) => {
            this.emitViewers(body.conversationId, workspaceId, viewerUserIds);
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
    // STEALTH GATE (operator mode): drop the start outright rather than
    // registering and filtering. A typing bubble is a live "someone is here
    // right now" signal — the strongest passive tell there is — and it relays
    // out to the webchat VISITOR too (`relayWidgetTyping`), i.e. to the
    // customer, not just the team. Dropping the start also means the matching
    // `typing:stop` no-ops on its own `typingIn.delete` gate, so there is no
    // stuck-bubble half-state to clean up.
    if (client.data.isOperator === true) return;
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
      this.relayWidgetTyping(body.conversationId);
    }
  }

  @SubscribeMessage("typing:stop")
  onTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { conversationId: string },
  ): void {
    if (!isValidBody(body, "conversationId")) return;
    // Stops are deliberately NOT charged against the typing budget: a stop is
    // bounded by a prior tracked start (the typingIn set delete below no-ops
    // otherwise), and dropping a STOP is strictly worse than dropping a start —
    // a budget-exhausted client's "X is typing…" pill stuck for the whole room
    // until the socket disconnected.
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
    this.relayWidgetTyping(body.conversationId);
  }

  // ---- team-chat channel rooms -------------------------------------------
  @SubscribeMessage("subscribe:channel")
  async onSubscribeChannel(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { channelId: string },
  ): Promise<void> {
    if (!isValidBody(body, "channelId")) return;
    const workspaceId = client.data.workspaceId as string | undefined;
    const userId = client.data.userId as string | undefined;
    if (!workspaceId || !userId) return;
    const room = channelRoom(body.channelId);

    // Mirror the subscribe:conversation idempotency split: a re-subscribe
    // (the common reconnect path after socket.io's connectionStateRecovery
    // restored the room) skips the membership check + budget charge but
    // STILL re-emits the typing snapshot. Without the always-emit, a long
    // reconnect (past recovery window, suspended laptop) left the client
    // showing stale typing pills until the next change ticked.
    const alreadyJoined = client.rooms.has(room);

    // Only a NEW join costs budget — a reconnect re-subscribe shouldn't be
    // charged for a room it is already in.
    if (!alreadyJoined && !checkSubscribeBudget(client, "subscribe:channel")) {
      return;
    }

    // Membership is re-checked on EVERY subscribe, including the re-subscribe
    // that follows a reconnect. It used to be skipped whenever the socket was
    // already in the room — but socket.io's connectionStateRecovery RESTORES a
    // socket's rooms without running any handler, and the members_changed
    // fanout rule's `evictUserFromChannelRoom` (emitter.service.ts)
    // can only reach sockets that are live at the moment membership is revoked.
    // So: revoke someone's access to a private channel while their laptop is
    // asleep, and on wake their socket was silently back in `chan:<id>` and
    // stayed there — receiving every message in a channel they'd been removed
    // from, indefinitely, because the "already joined" short-circuit meant the
    // check never ran again. Now a failed check LEAVES the room.
    // (Residual, inherent to recovery: frames buffered during the ≤30s
    // disconnect window are replayed before any handler runs. Closing that
    // completely means turning recovery off — a separate tradeoff.)
    try {
      // Mirrors `requireChannelMembership` in ChannelsService — default
      // channels short-circuit; everyone else must have a TeamChannelMember
      // row. Silently no-op on failure (don't teach a non-member that the
      // channel exists).
      const channel = await this.db.teamChannel.findFirst({
        where: { id: body.channelId, workspaceId },
        select: { id: true, isDefault: true },
      });
      let allowed = channel !== null;
      if (channel && !channel.isDefault) {
        const member = await this.db.teamChannelMember.findUnique({
          where: { channelId_userId: { channelId: body.channelId, userId } },
          select: { userId: true },
        });
        allowed = member !== null;
      }
      if (!allowed) {
        if (alreadyJoined) client.leave(room);
        return;
      }
    } catch (err) {
      this.logger.error(`subscribe:channel lookup failed: ${err}`);
      return;
    }

    if (!alreadyJoined) client.join(room);

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
    // STEALTH GATE (operator mode), same reasoning as the conversation twin:
    // typing is the strongest passive tell, and the operator reaches the
    // default channel without membership. Dropping the start makes the
    // matching stop a no-op on its own `typingInChannel.delete` gate.
    if (client.data.isOperator === true) return;
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
    // Stops are deliberately NOT charged against the typing budget: a stop is
    // bounded by a prior tracked start (the typingIn set delete below no-ops
    // otherwise), and dropping a STOP is strictly worse than dropping a start —
    // a budget-exhausted client's "X is typing…" pill stuck for the whole room
    // until the socket disconnected.
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
    const workspaceId = client.data.workspaceId as string | undefined;
    const typingInThread = client.data.typingInThread as Set<string> | undefined;
    const validatedThreads = client.data.validatedThreads as
      | Set<string>
      | undefined;
    if (!userId || !workspaceId || !typingInThread || !validatedThreads) return;
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
          where: { id: body.threadRootId, channelId: body.channelId, workspaceId },
          select: { id: true },
        });
        if (!root) return; // silently drop — don't leak that the thread exists
      } catch (err) {
        this.logger.error(`typing:thread:start lookup failed: ${err}`);
        return;
      }
      // Cap the memo like the neighbouring per-socket caches. Inbox sockets
      // live for days, so an uncapped Set accumulates one entry per distinct
      // thread the user has EVER typed in — tens of MB of resident heap across
      // thousands of long-lived sockets in a chat-heavy tenant, against a 2GB
      // container. Evicting the oldest costs at most one indexed re-validation,
      // which is already charged to the subscribe budget above.
      if (validatedThreads.size >= 200) {
        const oldest = validatedThreads.values().next().value;
        if (oldest !== undefined) validatedThreads.delete(oldest);
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
    // Stops are deliberately NOT charged against the typing budget: a stop is
    // bounded by a prior tracked start (the typingIn set delete below no-ops
    // otherwise), and dropping a STOP is strictly worse than dropping a start —
    // a budget-exhausted client's "X is typing…" pill stuck for the whole room
    // until the socket disconnected.
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
   * Disconnect every live socket bound to a workspace, forcing a re-handshake
   * that re-derives role + visibility + room membership. Used when an admin
   * flips `agentConversationVisibility` — the one setting whose enforcement
   * lives in handshake-time state. Restricted agents are NOT in the `ws:` room,
   * so this iterates all sockets rather than a room. ~hundreds of sockets at
   * this deployment's scale; the disconnect is `close=true` so clients
   * auto-reconnect immediately.
   */
  disconnectWorkspaceSockets(workspaceId: string): number {
    let dropped = 0;
    for (const s of this.server.sockets.sockets.values()) {
      if (s.data?.workspaceId === workspaceId) {
        s.disconnect(true);
        dropped++;
      }
    }
    if (dropped > 0) {
      this.logger.log(
        `disconnected ${dropped} socket(s) for workspace ${workspaceId} (visibility change)`,
      );
    }
    return dropped;
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
 * tenant-ownership check. 60 subscribes/10s caps the worst case while
 * leaving headroom for real keyboard triage — an agent j/k-ing at ~3
 * threads/sec exhausted the old 30 cap and the dropped subscribes left
 * on-screen threads silently missing conv-room frames until reconnect
 * (the hook subscribes once per mount, no retry). Bucket lives in
 * `client.data` so it dies with the socket.
 */
const SUB_CAP = 60;
const SUB_REFILL_PER_MS = 60 / 10_000;
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
function checkPresenceRequestBudget(
  client: Socket,
  // `viewers:request` runs on the same cadence (one per inbox mount /
  // reconnect) and wants the same ceiling, but its OWN tokens — sharing one
  // bucket would mean a reconnect flap spending the presence budget and
  // silently dropping the viewers re-seed, or the reverse.
  bucketKey: "__presenceBucket" | "__viewersBucket" = "__presenceBucket",
): boolean {
  const now = Date.now();

  const data = client.data as any;
  let bucket = data[bucketKey] as { tokens: number; ts: number } | undefined;
  if (!bucket) {
    bucket = { tokens: PRESENCE_REQUEST_CAP, ts: now };
    data[bucketKey] = bucket;
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
