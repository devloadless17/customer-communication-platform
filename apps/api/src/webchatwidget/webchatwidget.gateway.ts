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
import type { Namespace, Socket } from "socket.io";

import type { MediaKind, MessageStatus } from "@ccp/shared/types";
import type { NormalizedInboundMessage } from "@ccp/shared/providers/types";

import { DbService } from "../db/db.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { ingestEvents } from "@/lib/providers/ingest";
import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";
import { mapMessage } from "@/lib/queries/_shared";
import { REPLY_TO_INCLUDE } from "@/lib/queries/_shared";
import { applyWebchatPreChatIdentity } from "@/lib/identity/webchat-prechat";
import { recordConversationEvent } from "@/lib/inbox/events";
import {
  recordFirstSeenOrigin,
  resolveWebchatwidgetByPublicKey,
  widgetAllowsMediaKind,
  type WebchatwidgetResolved,
} from "@/lib/providers/webchatwidget-config";
import { createTokenBucket } from "../common/token-bucket";
import { originAllowed } from "./origin-allow";
import { widgetRoom } from "./rooms";
import { setWidgetVisitorSocketCounter } from "./widget-metrics";
import { frameFromMessage, type WidgetMessageFrame } from "./webchatwidget-frame";

const CHANNEL = "webchatwidget" as const;
/** How many recent messages we replay to a visitor on (re)connect. */
const HISTORY_LIMIT = 50;
/** Max chars accepted on a single visitor message (matches the capability cap). */
const MAX_BODY_CHARS = 4096;

/** How far back a client-claimed send time may reach (the offline-outbox window). */
const MAX_CLIENT_BACKDATE_MS = 24 * 60 * 60 * 1000;

/**
 * When the visitor typed a message, for messages that queued offline.
 *
 * Stamping `new Date()` at ingest was wrong for the offline case: three messages
 * typed while disconnected all landed at reconnect time and could interleave, so
 * the agent saw them out of the order they were written. The client therefore
 * sends the time it composed the message.
 *
 * That value is UNTRUSTED — a visitor controls their own clock, and a wild one
 * would sort their thread to the top of the inbox forever (or bury it). So it is
 * only honoured when it is in the past, within the outbox window, and never in
 * the future; anything else falls back to server time. Worst case a skewed clock
 * costs that visitor slightly-off ordering inside their own thread, which is the
 * same failure they already had.
 */
function resolveClientTimestamp(clientTs: number | undefined): Date {
  const now = Date.now();
  if (typeof clientTs !== "number" || !Number.isFinite(clientTs)) return new Date(now);
  if (clientTs > now || clientTs < now - MAX_CLIENT_BACKDATE_MS) return new Date(now);
  return new Date(clientTs);
}

/** Handshake rate limit: generous per-IP so a reconnect flap is fine, but bounded. */
const handshakeBucket = createTokenBucket({ perMin: 120 });
/** Per-visitor inbound message rate limit (a human can't type faster than this). */
const messageBucket = createTokenBucket({ perMin: 120 });
/**
 * Per-IP cap on creating BRAND-NEW conversations. `messageBucket` is keyed by
 * `${widgetId}:${visitorId}`, but visitorId is chosen by the client — rotating it
 * on every connect sidesteps that limit entirely, leaving only the 120/min
 * handshake bucket. That allowed one IP to mint ~120 new Contacts+Conversations a
 * minute, each firing the full pipeline (message.received, workflow dispatch,
 * outbound webhooks, agent frames, unread badges) — an inbox-spam and cost DoS
 * against the tenant. Only the FIRST message of a conversation is charged here, so
 * a normal visitor pays once and an established chat is untouched. Deliberately
 * generous so a shared corporate NAT / CGNAT egress isn't blocked.
 */
const newConversationBucket = createTokenBucket({ perMin: 15 });
/**
 * Budget for the cheap-but-not-free visitor frames (delivery/read receipts and
 * "load earlier"). Generous enough that a real visitor reading a thread and
 * paging back never notices, tight enough that a loop can't turn one anonymous
 * socket into hundreds of publishes per second. See `allowCheapFrame`.
 */
const receiptBucket = createTokenBucket({ perMin: 120 });

/** What we stash on each visitor socket after a successful handshake. */
interface WidgetSocketData {
  workspaceId: string;
  widgetId: string;
  visitorId: string;
  /** externalContactId = `${widgetId}:${visitorId}` — unique per widget. */
  externalContactId: string;
  resolved: WebchatwidgetResolved;
  conversationId: string | null;
  /** Handshake IP — the only visitor-independent key we can rate-limit new
   *  conversation creation on (visitorId is client-chosen, so it isn't one). */
  ip: string;
  /** Whether we've last relayed a typing-on to the agents (so disconnect can clear it). */
  typingOn?: boolean;
}

/** Body of a `visitor:message` frame. `body` is text or a media caption. */
interface VisitorMessageBody {
  clientMsgId: string;
  body?: string;
  media?: {
    mediaKey: string;
    mediaUrl: string;
    kind: MediaKind;
    mimeType: string;
    filename?: string;
    sizeBytes?: number;
    durationMs?: number;
    voice?: boolean;
  };
  replyToExternalId?: string;
  /**
   * When the visitor actually typed this, epoch ms. Only meaningful for a message
   * that sat in the offline outbox — see `resolveClientTimestamp`. Untrusted.
   */
  clientTs?: number;
  /** Sent only on the FIRST message (pre-chat form). */
  /** Sent only on the FIRST message (pre-chat form). `custom` holds any non-
   *  identity ("text") fields, keyed by label → contact custom field. */
  preChat?: { name?: string; email?: string; phone?: string; custom?: Record<string, string> };
  /** True when this first message follows the visitor's explicit "Start a new
   *  conversation" — records a timeline note on the fresh conversation. */
  startedNew?: boolean;
}

/**
 * Public visitor transport for the website chat widget — a SEPARATE Socket.io
 * namespace ("/widget") from the agent gateway. Anonymous visitors authenticate
 * with a public site key + an origin check (NOT a session cookie), so they can
 * never touch the agent namespace or its team rooms.
 *
 * Inbound: a `visitor:message` frame → a NormalizedInboundMessage → the SAME
 * `ingestEvents` every channel uses (creates Contact/Conversation/Message +
 * publishes `message.received`). Outbound (agent/automation replies + status) is
 * pushed here by WebchatwidgetDeliveryService via `deliverToVisitor`, which the
 * realtime tier calls when a `message.sent`/status event is on a webchatwidget
 * conversation. Media bytes never travel the socket — they're uploaded to R2 via
 * the public HTTP endpoint and referenced by key.
 */
@WebSocketGateway({ namespace: "/widget" })
export class WebchatwidgetGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(WebchatwidgetGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly db: DbService,
    private readonly realtime: RealtimeGateway,
  ) {}

  afterInit(server: Namespace): void {
    // Bridge agent typing → the visitor's widget. The agent gateway calls this
    // relay for EVERY conversation's typing; we just emit to that conversation's
    // widget room, which is a no-op for non-webchatwidget threads (nobody's in
    // the room) — so no channel lookup on the typing hot path.
    this.realtime.bindWidgetTypingRelay((conversationId, on) =>
      this.deliverToVisitor(conversationId, "typing", { on }),
    );
    // Agent availability → every visitor socket of that team, so the widget's dot
    // means "an agent is reachable" rather than "my own socket is up". Fired when
    // the team's presence flips (realtime broadcastPresence).
    this.realtime.bindWidgetAvailabilityRelay((workspaceId, online) => {
      if (!this.server) return;
      for (const sock of this.server.sockets.values()) {
        const d = sock.data as WidgetSocketData | undefined;
        if (d?.workspaceId === workspaceId) sock.emit("agents", { online });
      }
    });
    // Handshake auth runs as namespace middleware so a rejection delivers a typed
    // `connect_error` to the widget. The site key + origin allow-list IS the auth
    // (no cookies). Per-IP token bucket bounds a hostile reconnect loop.
    server.use((socket, next) => {
      void (async () => {
        try {
          const ip =
            (socket.handshake.headers["x-real-ip"] as string | undefined)?.trim() ||
            socket.handshake.address ||
            "unknown";
          if (!handshakeBucket.consume(ip).ok) {
            this.logger.warn(`widget handshake throttled ip=${ip}`);
            next(new Error("handshake_throttled"));
            return;
          }
          const auth = (socket.handshake.auth ?? {}) as {
            siteKey?: unknown;
            visitorId?: unknown;
          };
          const siteKey = typeof auth.siteKey === "string" ? auth.siteKey : "";
          const visitorId = typeof auth.visitorId === "string" ? auth.visitorId.slice(0, 128) : "";
          if (!siteKey || !visitorId) {
            next(new Error("bad_handshake"));
            return;
          }
          const resolved = await resolveWebchatwidgetByPublicKey(siteKey);
          if (!resolved) {
            // Diagnostics: a mistyped/rotated key is the #1 onboarding failure and
            // is otherwise INVISIBLE — the visitor just sees a dead widget. Log a
            // key PREFIX only (enough to correlate, not the whole credential).
            this.logger.warn(
              `widget handshake rejected: unknown_site_key key=${siteKey.slice(0, 12)}… ip=${ip}`,
            );
            next(new Error("unknown_site_key"));
            return;
          }
          const origin = (socket.handshake.headers.origin as string | undefined) ?? null;
          if (!originAllowed(origin, resolved.allowedOrigins)) {
            // The other half of the same class: the client embedded the widget on a
            // domain that isn't in its allow-list. Log the actual origin so support
            // can tell them exactly what to add.
            this.logger.warn(
              `widget handshake rejected: origin_not_allowed origin=${origin ?? "<none>"} widget=${resolved.widgetId} team=${resolved.workspaceId}`,
            );
            next(new Error("origin_not_allowed"));
            return;
          }
          // Trust-on-first-use: learn the domain this widget is really embedded on
          // so Settings can offer a one-click origin lock. Fire-and-forget — a
          // visitor's handshake must never wait on (or fail from) a bookkeeping
          // write, and the helper no-ops once the widget is locked or already known.
          void recordFirstSeenOrigin(siteKey, resolved, origin).catch((err) =>
            this.logger.warn(`first-seen-origin record failed: ${err}`),
          );
          const data: WidgetSocketData = {
            workspaceId: resolved.workspaceId,
            widgetId: resolved.widgetId,
            visitorId,
            externalContactId: `${resolved.widgetId}:${visitorId}`,
            resolved,
            conversationId: null,
            ip,
          };
          socket.data = data;
          next();
        } catch (err) {
          this.logger.error(`widget handshake failed: ${err instanceof Error ? err.message : err}`);
          next(new Error("handshake_error"));
        }
      })();
    });
    setWidgetVisitorSocketCounter(() => server.sockets.size);
    this.logger.log('Website-widget gateway ready (namespace "/widget")');
  }

  async handleConnection(client: Socket): Promise<void> {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.workspaceId) {
      client.disconnect(true);
      return;
    }
    // Hand the widget its appearance + pre-chat config over the socket (no
    // cross-origin HTTP fetch needed — the WS handshake already carried the site
    // key). The widget themes its launcher + panel from this.
    client.emit("ready", {
      widgetId: data.widgetId,
      name: data.resolved.name,
      config: data.resolved.config,
    });
    // Seed the availability dot for THIS visitor (the relay only fires on changes).
    // "online" here means an agent is connected AND available — not merely that
    // someone has a tab open; see `teamHasAvailableAgent`.
    client.emit("agents", {
      online: await this.realtime.teamHasAvailableAgent(data.workspaceId),
    });
    // Resume an existing conversation for this (widget, visitor): join its room
    // and replay recent history so replies sent while the widget was closed show
    // on reopen. Room is derived server-side from the resolved contact — a visitor
    // can NEVER join an arbitrary conversation id.
    try {
      const conversationId = await this.findConversationId(data.workspaceId, data.externalContactId);
      if (conversationId) {
        data.conversationId = conversationId;
        await client.join(widgetRoom(conversationId));
        // Tell agents viewing this thread the visitor is back on the page.
        this.realtime.notifyVisitorPresence(conversationId, true);
        client.emit("history", await this.history(data.workspaceId, conversationId));
      } else {
        client.emit("history", { messages: [], hasMore: false });
      }
    } catch (err) {
      this.logger.error(`widget connect resume failed: ${err instanceof Error ? err.message : err}`);
      client.emit("history", { messages: [], hasMore: false });
    }
  }

  @SubscribeMessage("visitor:message")
  async onVisitorMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: VisitorMessageBody,
  ): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.workspaceId) return { ok: false, error: "not_authenticated" };
    if (!body || typeof body !== "object" || typeof body.clientMsgId !== "string") {
      return { ok: false, error: "bad_message" };
    }
    if (!messageBucket.consume(`${data.widgetId}:${data.visitorId}`).ok) {
      return { ok: false, error: "rate_limited" };
    }

    const text = typeof body.body === "string" ? body.body.slice(0, MAX_BODY_CHARS) : "";
    const hasMedia = body.media && typeof body.media.mediaKey === "string";
    if (!text && !hasMedia) return { ok: false, error: "empty" };
    // Re-check the org's attachment policy at SEND time, not just at upload. The
    // upload endpoint is the primary gate, but a client could hold a mediaKey from
    // before the policy changed — this makes the two agree.
    if (hasMedia && !widgetAllowsMediaKind(data.resolved.config, body.media!.kind)) {
      return { ok: false, error: "media_kind_not_allowed" };
    }

    // TENANT GATE (§7): `mediaKey` arrives from the browser, so it is untrusted
    // input — without this check a visitor could name ANY key in the bucket
    // (e.g. `media/<other-team>/…`), have it persisted on their OWN conversation,
    // and then stream another tenant's private object back through
    // GET /api/widget/media/:id (whose ownership check validates the MESSAGE, not
    // the key). Keys are minted as `media/{workspaceId}/{yyyy}/{mm}/…` by the R2 key
    // builder, so requiring the handshake team's prefix binds the blob to the
    // team that uploaded it. Belt-and-braces: reject traversal segments too.
    if (hasMedia) {
      const key = body.media!.mediaKey;
      const url = body.media!.mediaUrl;
      // The url is persisted alongside the key and is what the forward/external
      // paths hand to `fetch()`, so it gets the provider's own SSRF/open-redirect
      // gate rather than being trusted because the key passed.
      if (
        !key.startsWith(`media/${data.workspaceId}/`) ||
        key.includes("..") ||
        typeof url !== "string" ||
        !blobStorage.isOwnUrl(url)
      ) {
        this.logger.warn(
          `[webchatwidget] rejected foreign media key/url on team=${data.workspaceId} widget=${data.widgetId}`,
        );
        return { ok: false, error: "bad_media" };
      }
    }

    // Charge the per-IP new-conversation budget only when this socket has no
    // conversation yet (see newConversationBucket). `data.conversationId` is set
    // on connect for a returning visitor and after the first send below, so an
    // ongoing chat never pays.
    const isNewConversation = data.conversationId === null;
    if (isNewConversation && !newConversationBucket.consume(data.ip).ok) {
      this.logger.warn(
        `widget new-conversation throttled ip=${data.ip} widget=${data.widgetId} team=${data.workspaceId}`,
      );
      return { ok: false, error: "rate_limited" };
    }

    // Dedupe key is stable per (widget, visitor, clientMsgId) so a reconnect
    // resend can't double-insert (the (workspaceId, channel, externalId) unique gate).
    const evt: NormalizedInboundMessage = {
      kind: "message",
      externalId: `${data.externalContactId}:${body.clientMsgId}`,
      externalContactId: data.externalContactId,
      contactName: body.preChat?.name?.trim() || null,
      body: text,
      timestamp: resolveClientTimestamp(body.clientTs),
      rawPayload: { source: "webchatwidget", clientMsgId: body.clientMsgId } as Record<
        string,
        unknown
      >,
      ...(body.replyToExternalId ? { replyToExternalId: body.replyToExternalId } : {}),
      ...(hasMedia
        ? {
            media: {
              kind: body.media!.kind,
              externalMediaId: "",
              mimeType: body.media!.mimeType,
              storageKey: body.media!.mediaKey,
              storageUrl: body.media!.mediaUrl,
              ...(body.media!.filename ? { filename: body.media!.filename } : {}),
              ...(body.media!.sizeBytes != null ? { sizeBytes: body.media!.sizeBytes } : {}),
              ...(body.media!.durationMs != null ? { durationMs: body.media!.durationMs } : {}),
              ...(body.media!.voice ? { voice: true } : {}),
            },
          }
        : {}),
    };

    try {
      await ingestEvents(data.workspaceId, CHANNEL, [evt]);
    } catch (err) {
      this.logger.error(`widget ingest failed: ${err instanceof Error ? err.message : err}`);
      return { ok: false, error: "ingest_failed" };
    }

    // Resolve the (now-created) conversation, stamp its source widget on first
    // sight, join the room, and best-effort apply the pre-chat identity.
    const conversationId = await this.findConversationId(data.workspaceId, data.externalContactId);
    if (!conversationId) return { ok: false, error: "no_conversation" };
    data.conversationId = conversationId;
    await client.join(widgetRoom(conversationId));
    // A brand-new visitor's conversation is created HERE (not on connect, which ran
    // before it existed), so announce presence now — otherwise an agent opening this
    // fresh thread would see "Away" while the visitor is actively typing to them.
    this.realtime.notifyVisitorPresence(conversationId, true);
    // Stamp which widget this conversation came from (writes once — the filter
    // matches only while it's still null).
    await this.db.conversation
      .updateMany({
        where: { id: conversationId, workspaceId: data.workspaceId, webchatWidgetId: null },
        data: { webchatWidgetId: data.widgetId },
      })
      .catch((err) => this.logger.error(`stamp widgetId failed: ${err}`));

    // The visitor deliberately started over ("Start a new conversation") → drop a
    // timeline note on this fresh thread so an agent knows it's a restart, not a
    // first-ever contact. Only on a genuinely new conversation, best-effort.
    if (isNewConversation && body.startedNew === true) {
      await recordConversationEvent({
        conversationId,
        workspaceId: data.workspaceId,
        userId: null,
        kind: "visitor_started_conversation",
      });
    }

    if (body.preChat) {
      const contactId = await this.contactIdFor(data.workspaceId, data.externalContactId);
      if (contactId) {
        await applyWebchatPreChatIdentity(data.workspaceId, CHANNEL, contactId, body.preChat).catch(
          (err) => this.logger.error(`prechat identity failed: ${err}`),
        );
      }
    }

    // First message of a NEW conversation: the room join above happened AFTER
    // ingestEvents, so the `message.received` fanout raced it and was very likely
    // emitted into a room this socket hadn't joined yet. The visitor's own first
    // message therefore never reconciles — most visibly, a first MEDIA message
    // keeps its local "📎 image" placeholder instead of rendering, until the next
    // reconnect. Replaying history now that we're in the room closes the gap;
    // it's idempotent client-side (upsert keys on message id, and the pending
    // clientMsgId match retires the optimistic bubble).
    if (isNewConversation) {
      try {
        client.emit("history", await this.history(data.workspaceId, conversationId));
      } catch (err) {
        this.logger.error(`widget first-message history replay failed: ${err}`);
      }
    }
    return { ok: true, conversationId };
  }

  /**
   * Visitor typing → relay to the agent inbox. Only meaningful once the visitor
   * has a conversation (first message sent). We stash the last state so the
   * disconnect handler can clear a stuck indicator when the tab vanishes.
   */
  @SubscribeMessage("visitor:typing")
  onVisitorTyping(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { on?: unknown },
  ): void {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.conversationId) return;
    // Rate-gate like the other visitor frames: the on/off state-flip dedupe below
    // is bypassed by an attacker alternating {on:true}/{on:false}, so without a
    // bucket one anonymous socket can flood notifyVisitorTyping at wire speed. A
    // real typist's ~2 flips/sec never trips the shared 120/min bucket.
    if (!this.allowCheapFrame(data)) return;
    const on = body?.on === true;
    if (on === (data.typingOn ?? false)) return;
    data.typingOn = on;
    this.realtime.notifyVisitorTyping(data.conversationId, on);
  }

  /** Clear a lingering "customer is typing…" if the visitor drops mid-type. */
  handleDisconnect(client: Socket): void {
    const data = client.data as WidgetSocketData | undefined;
    if (data?.conversationId) {
      if (data.typingOn) {
        data.typingOn = false;
        this.realtime.notifyVisitorTyping(data.conversationId, false);
      }
      // The visitor's tab closed / navigated away → agents stop waiting on them.
      // Only when THIS was the visitor's last socket for the conversation (a
      // reconnect/second tab must not flap "left"): re-check room membership.
      if (this.server && this.server.adapter.rooms.get(widgetRoom(data.conversationId)) == null) {
        this.realtime.notifyVisitorPresence(data.conversationId, false);
      }
    }
  }

  /**
   * Push a delivery frame to a visitor's conversation room. Called by the
   * delivery service on the realtime tier when an agent/automation message or a
   * status change lands on a webchatwidget conversation. No-op before the server
   * binds (boot) so an early event doesn't throw.
   */
  deliverToVisitor(conversationId: string, event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(widgetRoom(conversationId)).emit(event, payload);
  }

  // The visitor's browser received an agent message → mark outbound `delivered`.
  @SubscribeMessage("visitor:received")
  async onReceived(@ConnectedSocket() client: Socket): Promise<void> {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.conversationId || !this.allowCheapFrame(data)) return;
    await this.markOutbound(data.workspaceId, data.conversationId, "delivered");
  }

  // The panel is open + tab visible → mark outbound `read` (agent sees "Seen").
  @SubscribeMessage("visitor:read")
  async onRead(@ConnectedSocket() client: Socket): Promise<void> {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.conversationId || !this.allowCheapFrame(data)) return;
    await this.markOutbound(data.workspaceId, data.conversationId, "read");
  }

  /**
   * Rate gate for the non-message visitor frames (`visitor:received`,
   * `visitor:read`, `visitor:loadOlder`, `visitor:typing`).
   *
   * These were completely UNLIMITED on an anonymous socket, while the agent
   * gateway rate-limits every one of its handlers. `visitor:read` is the
   * expensive one: it can fan out to a `findMany` plus up to 200 sequential
   * `publish()` calls, each running the full subscriber chain — so a loop on the
   * one auth-free surface in the product was a cheap way to saturate the process.
   *
   * Keyed on the SERVER-RESOLVED conversationId, deliberately not the visitorId:
   * visitorId is chosen by the client, so a bucket keyed on it is bypassed by
   * rotating the value (the same weakness the message bucket carries).
   */
  private allowCheapFrame(data: WidgetSocketData): boolean {
    const key = data.conversationId ?? `${data.widgetId}:${data.ip}`;
    if (receiptBucket.consume(key).ok) return true;
    this.logger.warn(`widget receipt/history frame throttled conversation=${key}`);
    return false;
  }

  /**
   * Advance outbound messages' status and publish `message.status_changed` so the
   * agent inbox shows ✓✓ / Seen. A DIRECT mirror of ingestReadWatermark /
   * ingestDeliveredWatermark (ingest.ts): the `status in (...)` predicate keeps the
   * transition forward-only + idempotent (a re-fire matches 0 rows).
   */
  private async markOutbound(
    workspaceId: string,
    conversationId: string,
    status: "delivered" | "read",
  ): Promise<void> {
    const from: MessageStatus[] = status === "read" ? ["sent", "delivered"] : ["sent"];
    const msgs = await this.db.message.findMany({
      where: { workspaceId, conversationId, channel: CHANNEL, direction: "out", status: { in: from } },
      select: { id: true },
      // Bounded: each row below costs a publish() (outbox write + full subscriber
      // chain), so a visitor returning to a long-unread thread could otherwise turn
      // one `visitor:read` into hundreds of serial publishes. Newest first, since
      // those are the ones the agent is watching; the rest settle on later fires.
      orderBy: { timestamp: "desc" },
      take: 200,
    });
    if (msgs.length === 0) return;
    await this.db.message.updateMany({
      where: { id: { in: msgs.map((m) => m.id) } },
      data: { status },
    });
    const conv = await this.db.conversation.findUnique({
      where: { id: conversationId },
      select: { contactId: true },
    });
    if (!conv) return;
    const occurredAt = new Date().toISOString();
    for (const m of msgs) {
      await publish({
        type: "message.status_changed",
        workspaceId,
        channel: CHANNEL,
        conversationId,
        contactId: conv.contactId,
        messageId: m.id,
        status,
        occurredAt,
      });
    }
  }

  private async findConversationId(
    workspaceId: string,
    externalContactId: string,
  ): Promise<string | null> {
    const contact = await this.db.contact.findFirst({
      where: { workspaceId, identityChannel: CHANNEL, externalContactId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) return null;
    const conv = await this.db.conversation.findFirst({
      where: { workspaceId, contactId: contact.id },
      select: { id: true },
    });
    return conv?.id ?? null;
  }

  private async contactIdFor(workspaceId: string, externalContactId: string): Promise<string | null> {
    const contact = await this.db.contact.findFirst({
      where: { workspaceId, identityChannel: CHANNEL, externalContactId, deletedAt: null },
      select: { id: true },
    });
    return contact?.id ?? null;
  }

  /**
   * A page of history, newest-batch-first. `before` (keyset cursor) pages
   * BACKWARD for "load earlier". Returns `hasMore` so the widget knows whether to
   * keep offering "load earlier". Fetches LIMIT+1 to detect more without a count.
   */
  private async history(
    workspaceId: string,
    conversationId: string,
    before?: { ts: Date; id: string },
  ): Promise<{ messages: WidgetMessageFrame[]; hasMore: boolean }> {
    const rows = await this.db.message.findMany({
      omit: { rawPayload: true },
      include: { replyTo: REPLY_TO_INCLUDE },
      where: {
        workspaceId,
        conversationId,
        ...(before
          ? { OR: [{ timestamp: { lt: before.ts } }, { timestamp: before.ts, id: { lt: before.id } }] }
          : {}),
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: HISTORY_LIMIT + 1,
    });
    const hasMore = rows.length > HISTORY_LIMIT;
    const asc = (hasMore ? rows.slice(0, HISTORY_LIMIT) : rows).reverse();
    // Batch-resolve agent names for outbound messages so the widget shows who
    // replied — one query for the distinct senders on the page.
    const senderIds = [
      ...new Set(asc.filter((r) => r.direction === "out" && r.senderUserId).map((r) => r.senderUserId!)),
    ];
    const names = new Map<string, string>();
    if (senderIds.length > 0) {
      const users = await this.db.user.findMany({
        where: { id: { in: senderIds } },
        select: { id: true, name: true },
      });
      for (const u of users) names.set(u.id, u.name);
    }
    // Which outbound messages were AI-authored, so a refresh keeps the "AI" label.
    // History omits rawPayload (where the live path reads `sentVia`), so we read the
    // canonical `AiMessageMetadata.aiGenerated` — written after the send, thus always
    // present for past messages. One indexed query for the page's outbound ids.
    const outIds = asc.filter((r) => r.direction === "out").map((r) => r.id);
    const aiIds = new Set<string>();
    if (outIds.length > 0) {
      const meta = await this.db.aiMessageMetadata.findMany({
        where: { messageId: { in: outIds }, aiGenerated: true },
        select: { messageId: true },
      });
      for (const m of meta) aiIds.add(m.messageId);
    }
    const messages = asc.map((r) =>
      frameFromMessage(mapMessage(r), {
        senderName: r.senderUserId ? (names.get(r.senderUserId) ?? null) : null,
        ai: aiIds.has(r.id),
      }),
    );
    return { messages, hasMore };
  }

  /** "Load earlier" — a page of messages older than the widget's oldest, keyed
   *  off the (createdAt, id) cursor it holds. */
  @SubscribeMessage("visitor:loadOlder")
  async onLoadOlder(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { before?: { ts?: string; id?: string } },
  ): Promise<{ messages: WidgetMessageFrame[]; hasMore: boolean }> {
    const data = client.data as WidgetSocketData | undefined;
    const cur = body?.before;
    if (!data?.conversationId || !cur || typeof cur.ts !== "string" || typeof cur.id !== "string") {
      return { messages: [], hasMore: false };
    }
    // Two findMany's per call on an anonymous socket — same budget as the
    // receipts. On throttle echo hasMore:true (not false): a false ack is
    // persisted by widget.js and would permanently hide "Load earlier" for the
    // session even though more history exists — so a re-tap retries after refill.
    if (!this.allowCheapFrame(data)) return { messages: [], hasMore: true };
    // An unparseable timestamp makes Prisma throw, so the ack never fires and the
    // widget's `loadingOlder` latch stays true — "Load earlier" is then stuck on
    // "Loading…" for the rest of the session. Fail closed with an empty page.
    const ts = new Date(cur.ts);
    if (Number.isNaN(ts.getTime())) return { messages: [], hasMore: false };
    return this.history(data.workspaceId, data.conversationId, { ts, id: cur.id });
  }
}
