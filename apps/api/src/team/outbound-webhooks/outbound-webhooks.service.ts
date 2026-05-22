import { randomUUID } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";

import { encryptSecret } from "@/lib/crypto/envelope";
import { generateWebhookSecret } from "@/lib/outbound-webhooks/signing";
import { enqueueWebhookDelivery } from "@/lib/outbound-webhooks/queue";
import { channelSourceFor } from "@ccp/shared/outbound-webhooks/public-events";

import { DbService } from "../../db/db.service";
import type {
  CreateOutboundWebhookInput,
  ListDeliveriesQueryInput,
  UpdateOutboundWebhookInput,
} from "./outbound-webhooks.schemas";

export interface OutboundWebhookDto {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  enabled: boolean;
  consecutiveFailures: number;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  /** Set when the circuit breaker tripped (vs. an explicit admin disable). */
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface OutboundWebhookCreatedDto extends OutboundWebhookDto {
  /** Plaintext signing secret — returned ONCE. Lost = rotate. */
  secret: string;
}

@Injectable()
export class OutboundWebhooksService {
  constructor(private readonly db: DbService) {}

  async list(teamId: string): Promise<OutboundWebhookDto[]> {
    const rows = await this.db.outboundWebhook.findMany({
      where: { teamId },
      orderBy: { createdAt: "desc" },
      select: this.dtoSelect(),
    });
    return rows.map(this.toDto);
  }

  async create(
    teamId: string,
    userId: string,
    input: CreateOutboundWebhookInput,
  ): Promise<OutboundWebhookCreatedDto> {
    const secret = generateWebhookSecret();
    const row = await this.db.outboundWebhook.create({
      data: {
        teamId,
        name: input.name,
        url: input.url,
        secret: encryptSecret(secret),
        eventTypes: input.eventTypes,
        enabled: input.enabled ?? true,
        createdById: userId,
      },
      select: this.dtoSelect(),
    });
    return { ...this.toDto(row), secret };
  }

  async update(
    teamId: string,
    id: string,
    input: UpdateOutboundWebhookInput,
  ): Promise<OutboundWebhookDto> {
    const existing = await this.db.outboundWebhook.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "webhook not found" });

    // Re-enabling a previously-tripped breaker — clear the counter AND the
    // disable-audit columns so a fresh start is actually fresh (otherwise
    // it'd auto-disable again after 1 more failure, and the UI would keep
    // showing the old reason).
    const data: Parameters<typeof this.db.outboundWebhook.update>[0]["data"] = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.enabled === true
        ? {
            consecutiveFailures: 0,
            lastErrorAt: null,
            lastErrorMessage: null,
            disabledAt: null,
            disabledReason: null,
          }
        : {}),
    };

    const updated = await this.db.outboundWebhook.update({
      where: { id },
      data,
      select: this.dtoSelect(),
    });
    return this.toDto(updated);
  }

  /**
   * Generate a fresh secret + return it ONCE. Existing in-flight deliveries
   * already in the BullMQ queue will be signed with the NEW secret on
   * pickup (the worker reads from the row, not from a cached value at
   * enqueue time). Receivers must update their verifier when they rotate.
   */
  async rotateSecret(
    teamId: string,
    id: string,
  ): Promise<{ secret: string; webhook: OutboundWebhookDto }> {
    const existing = await this.db.outboundWebhook.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "webhook not found" });

    const secret = generateWebhookSecret();
    const updated = await this.db.outboundWebhook.update({
      where: { id },
      data: { secret: encryptSecret(secret) },
      select: this.dtoSelect(),
    });
    return { secret, webhook: this.toDto(updated) };
  }

  async remove(teamId: string, id: string): Promise<void> {
    const existing = await this.db.outboundWebhook.findFirst({
      where: { id, teamId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "webhook not found" });
    // FK cascade clears OutboundWebhookDelivery rows.
    await this.db.outboundWebhook.delete({ where: { id } });
  }

  async listDeliveries(
    teamId: string,
    webhookId: string,
    q: ListDeliveriesQueryInput,
  ) {
    const owned = await this.db.outboundWebhook.findFirst({
      where: { id: webhookId, teamId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException({ error: "webhook not found" });

    const rows = await this.db.outboundWebhookDelivery.findMany({
      where: { webhookId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map((d) => ({
      id: d.id,
      eventType: d.eventType,
      attemptCount: d.attemptCount,
      responseStatus: d.responseStatus,
      responseBody: d.responseBody,
      // The exact JSON envelope we POSTed — lets an admin inspect "what was
      // actually sent" when debugging a receiver. Small (one event envelope),
      // admin-only route, so returning it inline beats a second round-trip.
      payload: d.payload,
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      failedAt: d.failedAt?.toISOString() ?? null,
      errorMessage: d.errorMessage,
      createdAt: d.createdAt.toISOString(),
    }));
    const lastItem = rows[Math.min(rows.length, q.limit) - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  /**
   * Synthetic test fire. Posts a hand-crafted `webhook.test` envelope so
   * the partner can verify their receiver before relying on real events.
   * Reuses the same delivery + worker pipeline so the test exercises the
   * exact production path (signing, retries, log row).
   */
  async test(teamId: string, id: string): Promise<{ deliveryId: string }> {
    const wh = await this.db.outboundWebhook.findFirst({
      where: { id, teamId },
      select: { id: true, eventTypes: true },
    });
    if (!wh) throw new NotFoundException({ error: "webhook not found" });
    const eventType = wh.eventTypes[0] ?? "message.received";

    // Build the channel block in the SAME flat wire shape as real deliveries
    // (name = medium, source = "<medium>_business") so a receiver wiring its
    // parser against the test event sees the production shape, not a partial one.
    const conn = await this.db.channelConnection.findUnique({
      where: { teamId_channel: { teamId, channel: "whatsapp" } },
      select: { id: true, channel: true, createdAt: true },
    });
    const channel = conn
      ? {
          id: conn.id,
          name: conn.channel,
          source: channelSourceFor(conn.channel),
          meta: null,
          waId: null,
          profileName: null,
          created_at: Math.floor(conn.createdAt.getTime() / 1000),
        }
      : null;

    const deliveryId = randomUUID();
    const created = await this.db.outboundWebhookDelivery.create({
      data: {
        id: deliveryId,
        webhookId: id,
        eventType,
        // Flat wire shape (matches real deliveries) + a `test: true` marker so
        // receivers can route/ignore synthetic events.
        payload: {
          event_type: eventType,
          test: true,
          assignee: null,
          message: {
            messageId: deliveryId,
            channelMessageId: null,
            contactId: null,
            channelId: channel?.id ?? null,
            traffic: "incoming",
            timestamp: Date.now(),
            message: { type: "text", text: "This is a test delivery from your CCP webhook." },
            media: null,
          },
          channel,
          sender: {
            source: "contact",
            userId: null,
            teamId: null,
            workflowId: null,
            broadcastHistoryId: null,
          },
        },
      },
      select: { id: true },
    });
    await enqueueWebhookDelivery(created.id);
    return { deliveryId: created.id };
  }

  // ---- Helpers ----------------------------------------------------------

  private dtoSelect() {
    return {
      id: true,
      name: true,
      url: true,
      eventTypes: true,
      enabled: true,
      consecutiveFailures: true,
      createdAt: true,
      lastDeliveredAt: true,
      lastErrorAt: true,
      lastErrorMessage: true,
      disabledAt: true,
      disabledReason: true,
    } as const;
  }

  private toDto = (r: {
    id: string;
    name: string;
    url: string;
    eventTypes: string[];
    enabled: boolean;
    consecutiveFailures: number;
    createdAt: Date;
    lastDeliveredAt: Date | null;
    lastErrorAt: Date | null;
    lastErrorMessage: string | null;
    disabledAt: Date | null;
    disabledReason: string | null;
  }): OutboundWebhookDto => ({
    id: r.id,
    name: r.name,
    url: r.url,
    eventTypes: r.eventTypes,
    enabled: r.enabled,
    consecutiveFailures: r.consecutiveFailures,
    createdAt: r.createdAt.toISOString(),
    lastDeliveredAt: r.lastDeliveredAt?.toISOString() ?? null,
    lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
    lastErrorMessage: r.lastErrorMessage,
    disabledAt: r.disabledAt?.toISOString() ?? null,
    disabledReason: r.disabledReason,
  });
}
