import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { SubscriberPriority } from "@/lib/events/bus";

import { EventBus } from "../events/event-bus.module";
import { WebchatwidgetGateway } from "./webchatwidget.gateway";
import { frameFromMessage } from "./webchatwidget-frame";

const CHANNEL = "webchatwidget";

/**
 * Delivers webchatwidget domain events to the visitor's browser.
 *
 * Registered on the REALTIME tier (0) — the SAME tier as the agent-side socket
 * fanout — so an agent's reply reaches the visitor in the same critical frame it
 * reaches teammates. It only reacts to events on a `webchatwidget` conversation;
 * everything else is a cheap channel check and skip. No new event types, no bus
 * changes: it consumes the existing `message.received` / `message.sent` /
 * `message.status_changed` the outbound pipeline already publishes.
 *
 * The visitor's OWN inbound (`message.received`) is echoed back so a second tab
 * syncs and the widget can reconcile its optimistic bubble by matching the
 * clientMsgId embedded in `externalId`.
 */
@Injectable()
export class WebchatwidgetDeliveryService implements OnModuleInit, OnModuleDestroy {
  private offs: Array<() => void> = [];

  constructor(
    private readonly bus: EventBus,
    private readonly gateway: WebchatwidgetGateway,
  ) {}

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
        (e) => {
          if (e.message.channel !== CHANNEL) return;
          this.gateway.deliverToVisitor(e.conversationId, "message", frameFromMessage(e.message));
        },
        SubscriberPriority.REALTIME,
      ),
      this.bus.subscribe(
        "message.status_changed",
        (e) => {
          // `channel` is carried on the event for webchatwidget/social sends; when
          // absent (undefined) it can't be ours, so the cheap check skips without a
          // DB read. Delivers e.g. a "sent → delivered" tick to the visitor.
          if (e.channel !== CHANNEL) return;
          this.gateway.deliverToVisitor(e.conversationId, "message:status", {
            id: e.messageId,
            status: e.status,
          });
        },
        SubscriberPriority.REALTIME,
      ),
    );
    // NOTE: no `message.media_ready` / `conversation.status_changed` handlers —
    // webchatwidget inbound media is created media-ready (bytes are in R2 at
    // upload time, no async download), so media_ready never fires for it; and the
    // status event carries no `channel`, so filtering it would cost a DB read on
    // every channel's status change. A "chat ended" banner is a phase-2 polish.
  }

  onModuleDestroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }
}
