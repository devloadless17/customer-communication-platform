import { randomUUID } from "node:crypto";

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { subscribe } from "@/lib/events/bus";
import type { ChannelInfo } from "@ccp/shared/outbound-webhooks/public-events";
import {
  busEventTypesToSubscribe,
  toPublicEnvelopes,
} from "@ccp/shared/outbound-webhooks/public-events";

import { DbService } from "../db/db.service";
import { enqueueWebhookDelivery } from "@/lib/outbound-webhooks/queue";

/**
 * Bus subscriber that fans each allowlisted DomainEvent out to every
 * matching `OutboundWebhook` row for the event's team.
 *
 *   1. Filter: SQL-side lookup by `teamId` + `eventTypes` array contains.
 *   2. Stamp:  resolve the team's Meta config once into a `ChannelInfo`
 *              and inject it (+ a fresh event_id matching the delivery
 *              row id) into each envelope before persisting. This keeps
 *              the mapper in shared/ framework-agnostic — it doesn't
 *              know how to query the DB.
 *   3. Persist: insert one `OutboundWebhookDelivery` row per match so the
 *              worker reads the canonical payload + the partner can replay it.
 *   4. Enqueue: one `webhook:deliver` BullMQ job per delivery row.
 *
 * Order vs. other subscribers: this one fires AFTER audit + analytics +
 * workflow-dispatch — those subscribers might mutate state that should be
 * reflected in the outbound payload (close summary, firstResponseAt). Bus
 * `subscribe()` order is registration order, and `WorkflowSubscribersService`
 * registers audit/analytics/dispatch on its module init; by registering
 * after that module's onModuleInit runs (this module imports after), we
 * land last in the chain.
 *
 * Failures here MUST NOT throw to the bus — the per-handler try/catch in
 * `bus.ts` already isolates a thrown handler, but we want to log + carry on
 * with subsequent webhooks even when one match fails to persist.
 */
@Injectable()
export class OutboundWebhooksSubscriber implements OnModuleInit {
  private readonly logger = new Logger(OutboundWebhooksSubscriber.name);
  private registered = false;

  /**
   * Per-team channel info cache. Meta config rarely changes; per-event DB
   * lookup is a waste. Cleared on a `team.catalog_changed` event with
   * scope=`members` (closest signal we have for "team config touched";
   * sufficient since the only field we cache from the team row is the
   * Meta phone number, which is admin-edited from /settings/whatsapp).
   * The cache itself stays grow-only across team additions — those rows
   * never go away. Wholesale eviction is correct on multi-tenant churn.
   */
  private readonly channelCache = new Map<string, ChannelInfo>();

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;

    for (const eventType of busEventTypesToSubscribe()) {
      subscribe(eventType, async (event) => {
        try {
          await this.handle(event);
        } catch (err) {
          this.logger.error(
            `outbound-webhook dispatch failed for ${eventType}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      });
    }
    // Cache invalidator: a team-catalog change is the closest reliable
    // signal that the Meta phone number (the only team-row field we cache)
    // may have changed. Drop the row so the next event re-reads from DB.
    subscribe("team.catalog_changed", (event) => {
      if (this.channelCache.has(event.teamId)) {
        this.channelCache.delete(event.teamId);
      }
    });
    this.logger.log(
      `Outbound webhook subscriber registered for ${busEventTypesToSubscribe().length} event types`,
    );
  }

  private async handle(event: { teamId: string; type: string }) {
    const envelopes = toPublicEnvelopes(event as Parameters<typeof toPublicEnvelopes>[0]);
    if (envelopes.length === 0) return;

    // Single SQL query per event for all matching public event names.
    const publicTypes = Array.from(new Set(envelopes.map((e) => e.type)));
    const webhooks = await this.db.outboundWebhook.findMany({
      where: {
        teamId: event.teamId,
        enabled: true,
        eventTypes: { hasSome: publicTypes },
      },
      select: { id: true, eventTypes: true },
    });
    if (webhooks.length === 0) return;

    const channel = await this.resolveChannel(event.teamId);

    for (const { type, envelope } of envelopes) {
      const matching = webhooks.filter((w) => w.eventTypes.includes(type));
      if (matching.length === 0) continue;

      // Create delivery rows with pre-generated ids so the stamped event_id
      // matches the row id exactly — partners can cross-reference webhook
      // body event_id ↔ X-CCP-Delivery header ↔ delivery log row in one hop.
      const created = await Promise.all(
        matching.map(async (w) => {
          const deliveryId = randomUUID();
          const payload = {
            ...envelope,
            event_id: deliveryId,
            channel,
          };
          return this.db.outboundWebhookDelivery.create({
            data: {
              id: deliveryId,
              webhookId: w.id,
              eventType: type,
              payload: payload as unknown as Parameters<
                typeof this.db.outboundWebhookDelivery.create
              >[0]["data"]["payload"],
            },
            select: { id: true },
          });
        }),
      );
      await Promise.all(
        created.map((d) =>
          enqueueWebhookDelivery(d.id).catch((err) => {
            this.logger.error(
              `enqueue failed for delivery ${d.id}: ${err instanceof Error ? err.message : err}`,
            );
          }),
        ),
      );
    }
  }

  /**
   * Resolve the team's Meta config into a public ChannelInfo. Cached per-team
   * for the process lifetime — Meta phone numbers rarely change, and a fresh
   * lookup on every event burns budget on a hot bus subscriber. On cache miss,
   * we hit the DB; on subsequent calls within the process, it's a Map read.
   */
  private async resolveChannel(teamId: string): Promise<ChannelInfo | null> {
    const cached = this.channelCache.get(teamId);
    if (cached) return cached;

    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { metaPhoneNumberId: true, metaDisplayPhoneNumber: true },
    });
    if (!team) return null;

    const channel: ChannelInfo = {
      source: "meta_cloud",
      phone_number_id: team.metaPhoneNumberId,
      display_phone_number: team.metaDisplayPhoneNumber,
    };
    this.channelCache.set(teamId, channel);
    return channel;
  }
}
