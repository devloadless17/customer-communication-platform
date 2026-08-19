import { randomUUID } from "node:crypto";

import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { encryptSecret } from "@/lib/crypto/envelope";
import { assertRegistrableHost, SsrfBlockedError } from "@/lib/http/safe-fetch";
import { generateWebhookSecret, WEBHOOK_WIRE_VERSION } from "@/lib/outbound-webhooks/signing";
import { enqueueWebhookDelivery } from "@/lib/outbound-webhooks/queue";
import {
  channelSourceFor,
  samplePayloadFor,
  toWirePayload,
  type PublicEventType,
  type WireChannelBase,
} from "@ccp/shared/outbound-webhooks/public-events";

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

/**
 * See create(). Every matching event fans out one delivery row + one queued
 * POST per endpoint, and the per-workspace delivery-slot gate is small — an
 * unbounded endpoint list starves a tenant's own real deliveries.
 */
const MAX_WEBHOOKS_PER_WORKSPACE = 20;

export interface OutboundWebhookCreatedDto extends OutboundWebhookDto {
  /** Plaintext signing secret — returned ONCE. Lost = rotate. */
  secret: string;
}

@Injectable()
export class OutboundWebhooksService {
  constructor(private readonly db: DbService) {}

  async list(workspaceId: string): Promise<OutboundWebhookDto[]> {
    const rows = await this.db.outboundWebhook.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      select: this.dtoSelect(),
    });
    return rows.map(this.toDto);
  }

  async create(
    workspaceId: string,
    /** Null when an API key created it — an integration is not a person. */
    userId: string | null,
    input: CreateOutboundWebhookInput,
  ): Promise<OutboundWebhookCreatedDto> {
    this.assertUrlSafe(input.url);
    const count = await this.db.outboundWebhook.count({ where: { workspaceId } });
    if (count >= MAX_WEBHOOKS_PER_WORKSPACE) {
      throw new BadRequestException({
        error: "webhook_limit_reached",
        detail: `This workspace has reached its limit of ${MAX_WEBHOOKS_PER_WORKSPACE} outbound webhooks. Delete an unused endpoint to make room.`,
      });
    }
    const secret = generateWebhookSecret();
    const row = await this.db.outboundWebhook.create({
      data: {
        workspaceId,
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
    workspaceId: string,
    id: string,
    input: UpdateOutboundWebhookInput,
  ): Promise<OutboundWebhookDto> {
    const existing = await this.db.outboundWebhook.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "webhook_not_found" });

    if (input.url !== undefined) this.assertUrlSafe(input.url);

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
   * Reject obvious SSRF / non-public webhook targets at REGISTRATION (private
   * IP literals + internal hostnames + bad scheme/creds), not just at delivery.
   * Uses the SYNTACTIC check (no DNS) — registration must still accept a domain
   * that doesn't resolve yet (not-yet-propagated / transient DNS / a `*.invalid`
   * test domain). The delivery path (safeFetch → assertPublicHost, with DNS,
   * re-run per hop) stays the AUTHORITATIVE guard against rebinding. Honors the
   * INTEGRATIONS_ALLOW_PRIVATE_HOSTS dev escape hatch.
   */
  private assertUrlSafe(url: string): void {
    // Plain http leaks customer PII + message bodies in cleartext on every
    // delivery. The schema accepts http so a dev can point at a local receiver,
    // but that's only sound behind the same dev escape hatch safe-fetch uses
    // (INTEGRATIONS_ALLOW_PRIVATE_HOSTS=1). In production, reject http here so
    // the enforced rule actually matches the "must be a public https endpoint"
    // message below — previously the message claimed https but http went
    // through unchecked.
    const allowHttp = process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS === "1";
    if (!allowHttp && url.trim().toLowerCase().startsWith("http://")) {
      throw new BadRequestException({
        error: "url_not_allowed",
        detail:
          "Webhook URL must be a public https endpoint — plain http is not allowed in production.",
      });
    }
    try {
      assertRegistrableHost(url);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        throw new BadRequestException({
          error: "url_not_allowed",
          detail:
            "Webhook URL must be a public https endpoint, not a private/internal host.",
        });
      }
      throw err;
    }
  }

  /**
   * Generate a fresh secret + return it ONCE. Existing in-flight deliveries
   * already in the BullMQ queue will be signed with the NEW secret on
   * pickup (the worker reads from the row, not from a cached value at
   * enqueue time). Receivers must update their verifier when they rotate.
   */
  async rotateSecret(
    workspaceId: string,
    id: string,
  ): Promise<{ secret: string; webhook: OutboundWebhookDto }> {
    const existing = await this.db.outboundWebhook.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "webhook_not_found" });

    const secret = generateWebhookSecret();
    const updated = await this.db.outboundWebhook.update({
      where: { id },
      data: { secret: encryptSecret(secret) },
      select: this.dtoSelect(),
    });
    return { secret, webhook: this.toDto(updated) };
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const existing = await this.db.outboundWebhook.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException({ error: "webhook_not_found" });
    // FK cascade clears OutboundWebhookDelivery rows.
    await this.db.outboundWebhook.delete({ where: { id } });
  }

  async listDeliveries(
    workspaceId: string,
    webhookId: string,
    q: ListDeliveriesQueryInput,
  ) {
    const owned = await this.db.outboundWebhook.findFirst({
      where: { id: webhookId, workspaceId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException({ error: "webhook_not_found" });

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
   * Synthetic test fire. Builds the body in the REAL wire shape of the
   * webhook's first subscribed event type (via the documented sample payload →
   * `toWirePayload`), marked `test: true`, so the partner validates their
   * parser against the exact shape production will send — not a fixed
   * message-shaped stub. Reuses the same delivery + worker pipeline so the test
   * exercises the production path (signing, retries, log row).
   */
  async test(workspaceId: string, id: string): Promise<{ deliveryId: string }> {
    const wh = await this.db.outboundWebhook.findFirst({
      where: { id, workspaceId },
      select: { id: true, eventTypes: true },
    });
    if (!wh) throw new NotFoundException({ error: "webhook_not_found" });
    // Use the FIRST subscribed event type and build the body in THAT type's
    // real shape — a webhook subscribed only to e.g. `contact.tag_changed`
    // would otherwise get a message-shaped test body it can't parse against.
    // The column is `string[]` but every entry was validated against
    // PublicEventEnum on write, so the cast is sound.
    const eventType = (wh.eventTypes[0] ?? "message.received") as PublicEventType;

    // Resolve the team's channel into the same `WireChannelBase` the real
    // subscriber passes to `toWirePayload`, so the channel block on the test
    // matches production (name = medium, source = "<medium>_business").
    // Reflect a real connected channel in the test ping — prefer WhatsApp for
    // continuity, but fall back to any active connection so a Messenger /
    // Instagram-only workspace's test body still carries a real channel block.
    // Select the SAME columns the subscriber does — the test ping must be
    // byte-identical to a live delivery, which is the whole point of it, and
    // that now includes the account identity fields.
    const identitySelect = {
      id: true,
      channel: true,
      createdAt: true,
      label: true,
      externalAccountId: true,
      config: true,
    } as const;
    // DETERMINISTIC pick. The ping's whole purpose is byte-identical parity
    // with a live delivery, and it now carries account_label / account_address
    // / account_external_id — so an unordered findFirst handed a partner
    // validating their parser a different account run to run. Default first,
    // then oldest, matching how the accounts list itself orders.
    const conn =
      (await this.db.channelConnection.findFirst({
        where: { workspaceId, channel: "whatsapp", isActive: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: identitySelect,
      })) ??
      (await this.db.channelConnection.findFirst({
        where: { workspaceId, isActive: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        select: identitySelect,
      }));
    const channelBase: WireChannelBase | null = conn
      ? {
          id: conn.id,
          name: conn.channel,
          source: channelSourceFor(conn.channel),
          // Epoch MS — must match the production fanout (subscriber) so the Test
          // ping is byte-identical to a live delivery for parser validation.
          created_at: conn.createdAt.getTime(),
          account_label: conn.label,
          account_address:
            (conn.config as { displayPhoneNumber?: string } | null)?.displayPhoneNumber ?? null,
          account_external_id: conn.externalAccountId || null,
          // The ping has no event to resolve an account FROM, so this pick IS
          // the fallback — and saying so keeps the ping honest rather than
          // teaching a partner that the flag is always false.
          account_is_default_fallback: true,
        }
      : null;

    // Reflect the workspace AI Autopilot opt-in in the test ping's `ai_enabled`
    // so a Test fired while the feature is off matches what a real inbound shows.
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiAutopilotEnabled: true },
    });

    const deliveryId = randomUUID();
    // team_id stamped first + `test: true` marker, then the type's real wire
    // shape — exactly what the production fanout produces (subscriber.ts:245).
    const payload = {
      v: WEBHOOK_WIRE_VERSION,
      team_id: workspaceId,
      // Same dedup key the production fanout stamps (= the delivery row id, =
      // the X-CCP-Delivery header) — the ping exists to validate a parser, so
      // it must carry every field a live delivery does.
      event_id: deliveryId,
      test: true,
      // Top-level `timestamp` — production fanout always stamps it (epoch ms)
      // BEFORE the spread, so a Test ping must too, or it wouldn't be byte-shape
      // identical for parser validation on every event type other than
      // message.status_changed (whose per-case timestamp in the spread wins).
      // No envelope occurred_at on the Test path, so use "now".
      timestamp: Date.now(),
      ...toWirePayload(eventType, samplePayloadFor(eventType), {
        channelBase,
        teamAiAutopilotEnabled: team?.aiAutopilotEnabled ?? false,
      }),
    };
    const created = await this.db.outboundWebhookDelivery.create({
      data: {
        id: deliveryId,
        webhookId: id,
        eventType,
        payload: payload as unknown as Parameters<
          typeof this.db.outboundWebhookDelivery.create
        >[0]["data"]["payload"],
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
