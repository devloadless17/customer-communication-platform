import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { SubscriberPriority } from "@/lib/events/bus";

import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";
import { WebchatwidgetGateway } from "./webchatwidget.gateway";
import { frameFromMessage } from "./webchatwidget-frame";

const CHANNEL = "webchatwidget";

/** Was this outbound written by the AI assistant? The native orchestrator + the
 *  accepted-suggestion path both stamp `rawPayload.sentVia = "ai-assistant/…"`
 *  synchronously at send time (voice-delivery.ts / ai-inbox.service.ts), so this
 *  is readable in the realtime frame with no extra read. */
function isAiSend(rawPayload: Record<string, unknown> | undefined): boolean {
  const via = rawPayload?.sentVia;
  return typeof via === "string" && via.startsWith("ai-assistant");
}

/**
 * Delivers webchatwidget domain events to the visitor's browser.
 *
 * Registered on the REALTIME tier (0) — the SAME tier as the agent-side socket
 * fanout — so an agent's reply reaches the visitor in the same critical frame it
 * reaches teammates. It only reacts to events on a `webchatwidget` conversation;
 * everything else is a cheap channel check and skip. No new event types, no bus
 * changes: it consumes the existing `message.received` / `message.sent` /
 * `message.status_changed` / `conversation.status_changed` the pipeline already
 * publishes.
 *
 * The visitor's OWN inbound (`message.received`) is echoed back so a second tab
 * syncs and the widget can reconcile its optimistic bubble by matching the
 * clientMsgId embedded in `externalId`.
 */
@Injectable()
export class WebchatwidgetDeliveryService implements OnModuleInit, OnModuleDestroy {
  private offs: Array<() => void> = [];
  // userId → display name. Grow-only, tiny (team size); names change rarely and
  // a stale one self-heals on the next process boot. Keeps the realtime frame off
  // a DB read per agent message once warm.
  private readonly nameCache = new Map<string, string>();

  constructor(
    private readonly bus: EventBus,
    private readonly db: DbService,
    private readonly gateway: WebchatwidgetGateway,
  ) {}

  private async nameFor(userId: string): Promise<string | null> {
    const hit = this.nameCache.get(userId);
    if (hit !== undefined) return hit;
    try {
      const u = await this.db.user.findUnique({ where: { id: userId }, select: { name: true } });
      const name = u?.name ?? "";
      this.nameCache.set(userId, name);
      return name || null;
    } catch {
      return null;
    }
  }

  onModuleInit(): void {
    this.offs.push(
      this.bus.subscribe(
        "message.received",
        (e) => {
          if (e.message.channel !== CHANNEL) return;
          this.gateway.deliverToVisitor(e.conversationId, "message", frameFromMessage(e.message));
        },
        SubscriberPriority.REALTIME,
      ),
      this.bus.subscribe(
        "message.sent",
        async (e) => {
          if (e.message.channel !== CHANNEL) return;
          // Attribute the reply to the agent (skip system/automation sends). An AI
          // reply carries no senderUserId; we detect it from the send provenance
          // (`rawPayload.sentVia = "ai-assistant/…"`), which is set synchronously on
          // the message, so the widget can disclose the bot without a DB read.
          const senderName = e.senderUserId ? await this.nameFor(e.senderUserId) : null;
          const ai = isAiSend(e.message.rawPayload);
          this.gateway.deliverToVisitor(
            e.conversationId,
            "message",
            frameFromMessage(e.message, { senderName, ai }),
          );
        },
        SubscriberPriority.REALTIME,
      ),
      this.bus.subscribe(
        "message.status_changed",
        (e) => {
          // `channel` is carried for webchatwidget/social sends; absent → not ours,
          // so the cheap check skips without a DB read. This mostly forwards the
          // visitor's OWN read/delivered receipts (they don't need them), but it's
          // harmless and keeps the widget's tick state exact.
          if (e.channel !== CHANNEL) return;
          this.gateway.deliverToVisitor(e.conversationId, "message:status", {
            id: e.messageId,
            status: e.status,
          });
        },
        SubscriberPriority.REALTIME,
      ),
      this.bus.subscribe(
        "conversation.status_changed",
        (e) => {
          // The event's conversation snapshot already carries the channel — a
          // cheap check, no DB read. Lets the widget show a "chat closed" /
          // reopened notice.
          if (e.conversation.channel !== CHANNEL) return;
          this.gateway.deliverToVisitor(e.conversationId, "conversation:status", {
            status: e.newStatus,
          });
        },
        SubscriberPriority.REALTIME,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
