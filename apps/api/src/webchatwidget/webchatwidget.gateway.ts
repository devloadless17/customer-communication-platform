import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
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
import { publish } from "@/lib/events/bus";
import { mapMessage } from "@/lib/queries/_shared";
import { REPLY_TO_INCLUDE } from "@/lib/queries/_shared";
import { applyWebchatPreChatIdentity } from "@/lib/identity/webchat-prechat";
import {
  resolveWebchatwidgetByPublicKey,
  type WebchatwidgetResolved,
} from "@/lib/providers/webchatwidget-config";
import { createTokenBucket } from "../common/token-bucket";
import { originAllowed } from "./origin-allow";
import { widgetRoom } from "./rooms";
import { frameFromMessage, type WidgetMessageFrame } from "./webchatwidget-frame";

const CHANNEL = "webchatwidget" as const;
/** How many recent messages we replay to a visitor on (re)connect. */
const HISTORY_LIMIT = 50;
/** Max chars accepted on a single visitor message (matches the capability cap). */
const MAX_BODY_CHARS = 4096;

/** Handshake rate limit: generous per-IP so a reconnect flap is fine, but bounded. */
const handshakeBucket = createTokenBucket({ perMin: 120 });
/** Per-visitor inbound message rate limit (a human can't type faster than this). */
const messageBucket = createTokenBucket({ perMin: 120 });

/** What we stash on each visitor socket after a successful handshake. */
interface WidgetSocketData {
  teamId: string;
  widgetId: string;
  visitorId: string;
  /** externalContactId = `${widgetId}:${visitorId}` — unique per widget. */
  externalContactId: string;
  resolved: WebchatwidgetResolved;
  conversationId: string | null;
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
  /** Sent only on the FIRST message (pre-chat form). */
  preChat?: { name?: string; email?: string; phone?: string };
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
export class WebchatwidgetGateway implements OnGatewayInit, OnGatewayConnection {
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
            next(new Error("unknown_site_key"));
            return;
          }
          const origin = (socket.handshake.headers.origin as string | undefined) ?? null;
          if (!originAllowed(origin, resolved.allowedOrigins)) {
            next(new Error("origin_not_allowed"));
            return;
          }
          const data: WidgetSocketData = {
            teamId: resolved.teamId,
            widgetId: resolved.widgetId,
            visitorId,
            externalContactId: `${resolved.widgetId}:${visitorId}`,
            resolved,
            conversationId: null,
          };
          socket.data = data;
          next();
        } catch (err) {
          this.logger.error(`widget handshake failed: ${err instanceof Error ? err.message : err}`);
          next(new Error("handshake_error"));
        }
      })();
    });
    this.logger.log('Website-widget gateway ready (namespace "/widget")');
  }

  async handleConnection(client: Socket): Promise<void> {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.teamId) {
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
    // Resume an existing conversation for this (widget, visitor): join its room
    // and replay recent history so replies sent while the widget was closed show
    // on reopen. Room is derived server-side from the resolved contact — a visitor
    // can NEVER join an arbitrary conversation id.
    try {
      const conversationId = await this.findConversationId(data.teamId, data.externalContactId);
      if (conversationId) {
        data.conversationId = conversationId;
        await client.join(widgetRoom(conversationId));
        client.emit("history", { messages: await this.history(data.teamId, conversationId) });
      } else {
        client.emit("history", { messages: [] });
      }
    } catch (err) {
      this.logger.error(`widget connect resume failed: ${err instanceof Error ? err.message : err}`);
      client.emit("history", { messages: [] });
    }
  }

  @SubscribeMessage("visitor:message")
  async onVisitorMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: VisitorMessageBody,
  ): Promise<{ ok: boolean; conversationId?: string; error?: string }> {
    const data = client.data as WidgetSocketData | undefined;
    if (!data?.teamId) return { ok: false, error: "not_authenticated" };
    if (!body || typeof body !== "object" || typeof body.clientMsgId !== "string") {
      return { ok: false, error: "bad_message" };
    }
    if (!messageBucket.consume(`${data.widgetId}:${data.visitorId}`).ok) {
      return { ok: false, error: "rate_limited" };
    }

    const text = typeof body.body === "string" ? body.body.slice(0, MAX_BODY_CHARS) : "";
    const hasMedia = body.media && typeof body.media.mediaKey === "string";
    if (!text && !hasMedia) return { ok: false, error: "empty" };

    // Dedupe key is stable per (widget, visitor, clientMsgId) so a reconnect
    // resend can't double-insert (the (teamId, channel, externalId) unique gate).
    const evt: NormalizedInboundMessage = {
      kind: "message",
      externalId: `${data.externalContactId}:${body.clientMsgId}`,
      externalContactId: data.externalContactId,
      contactName: body.preChat?.name?.trim() || null,
      body: text,
      timestamp: new Date(),
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
      await ingestEvents(data.teamId, CHANNEL, [evt]);
    } catch (err) {
      this.logger.error(`widget ingest failed: ${err instanceof Error ? err.message : err}`);
      return { ok: false, error: "ingest_failed" };
    }

    // Resolve the (now-created) conversation, stamp its source widget on first
    // sight, join the room, and best-effort apply the pre-chat identity.
    const conversationId = await this.findConversationId(data.teamId, data.externalContactId);
    if (!conversationId) return { ok: false, error: "no_conversation" };
    data.conversationId = conversationId;
    await client.join(widgetRoom(conversationId));
    // Stamp which widget this conversation came from (writes once — the filter
    // matches only while it's still null).
    await this.db.conversation
      .updateMany({
        where: { id: conversationId, teamId: data.teamId, webchatWidgetId: null },
        data: { webchatWidgetId: data.widgetId },
      })
      .catch((err) => this.logger.error(`stamp widgetId failed: ${err}`));

    if (body.preChat) {
      const contactId = await this.contactIdFor(data.teamId, data.externalContactId);
      if (contactId) {
        await applyWebchatPreChatIdentity(data.teamId, CHANNEL, contactId, body.preChat).catch(
          (err) => this.logger.error(`prechat identity failed: ${err}`),
        );
      }
    }
    return { ok: true, conversationId };
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
    if (data?.conversationId) await this.markOutbound(data.teamId, data.conversationId, "delivered");
  }

  // The panel is open + tab visible → mark outbound `read` (agent sees "Seen").
  @SubscribeMessage("visitor:read")
  async onRead(@ConnectedSocket() client: Socket): Promise<void> {
    const data = client.data as WidgetSocketData | undefined;
    if (data?.conversationId) await this.markOutbound(data.teamId, data.conversationId, "read");
  }

  /**
   * Advance outbound messages' status and publish `message.status_changed` so the
   * agent inbox shows ✓✓ / Seen. A DIRECT mirror of ingestReadWatermark /
   * ingestDeliveredWatermark (ingest.ts): the `status in (...)` predicate keeps the
   * transition forward-only + idempotent (a re-fire matches 0 rows).
   */
  private async markOutbound(
    teamId: string,
    conversationId: string,
    status: "delivered" | "read",
  ): Promise<void> {
    const from: MessageStatus[] = status === "read" ? ["sent", "delivered"] : ["sent"];
    const msgs = await this.db.message.findMany({
      where: { teamId, conversationId, channel: CHANNEL, direction: "out", status: { in: from } },
      select: { id: true },
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
        teamId,
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
    teamId: string,
    externalContactId: string,
  ): Promise<string | null> {
    const contact = await this.db.contact.findFirst({
      where: { teamId, identityChannel: CHANNEL, externalContactId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) return null;
    const conv = await this.db.conversation.findFirst({
      where: { teamId, contactId: contact.id },
      select: { id: true },
    });
    return conv?.id ?? null;
  }

  private async contactIdFor(teamId: string, externalContactId: string): Promise<string | null> {
    const contact = await this.db.contact.findFirst({
      where: { teamId, identityChannel: CHANNEL, externalContactId, deletedAt: null },
      select: { id: true },
    });
    return contact?.id ?? null;
  }

  private async history(teamId: string, conversationId: string): Promise<WidgetMessageFrame[]> {
    const rows = await this.db.message.findMany({
      omit: { rawPayload: true },
      include: { replyTo: REPLY_TO_INCLUDE },
      where: { teamId, conversationId },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: HISTORY_LIMIT,
    });
    const asc = rows.reverse();
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
    return asc.map((r) =>
      frameFromMessage(mapMessage(r), {
        senderName: r.senderUserId ? (names.get(r.senderUserId) ?? null) : null,
      }),
    );
  }
}
