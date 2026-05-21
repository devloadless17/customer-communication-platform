import { randomUUID } from "node:crypto";

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { subscribe } from "@/lib/events/bus";
import type {
  AssigneeInfo,
  ChannelInfo,
  PublicContact,
  PublicEventType,
} from "@ccp/shared/outbound-webhooks/public-events";
import {
  busEventTypesToSubscribe,
  toPublicEnvelopes,
} from "@ccp/shared/outbound-webhooks/public-events";

import { DbService } from "../db/db.service";
import { enqueueWebhookDelivery } from "@/lib/outbound-webhooks/queue";
import {
  EXTERNAL_CONVERSATION_INCLUDE,
  conversationRowToExternal,
  type ExternalContact,
} from "@/lib/external-shapes";

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

    // Single SQL query per event for all matching public event names. Done
    // FIRST so we skip every enrichment lookup below when no webhook is
    // subscribed to this event for this team (the overwhelmingly common case).
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

    // Enrich each public payload with everything the framework-agnostic mapper
    // couldn't derive (it has no DB access). Best-effort: a failed lookup
    // leaves the documented `null` in place rather than dropping the delivery.
    //   1. media CDN urls on file messages (image/video/doc links)
    //   2. full contact + conversation (status, assignee) on message.sent so
    //      it matches message.received's context
    //   3. assignee + sender display names / emails wherever they're id-only
    await this.enrichMediaUrls(envelopes);
    await this.enrichSentMessageContext(envelopes);
    await this.hydrateUsers(envelopes);

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
   * Fill `media.url` + `media.thumbnail_url` on message-bearing envelopes from
   * the raw CDN columns. One batched lookup across all media messages in the
   * event (≤2 in practice). Best-effort: a missing row or a not-yet-uploaded
   * media leaves the url null, which the payload already documents.
   */
  private async enrichMediaUrls(
    envelopes: Array<{ envelope: { data: unknown } }>,
  ): Promise<void> {
    type MediaShape = {
      url: string | null;
      thumbnail_url: string | null;
    };
    type MsgData = { message?: { id?: string; media?: MediaShape | null } };

    const mediaByMessageId = new Map<string, MediaShape>();
    for (const { envelope } of envelopes) {
      const data = envelope.data as MsgData;
      const id = data.message?.id;
      const media = data.message?.media;
      if (id && media) mediaByMessageId.set(id, media);
    }
    if (mediaByMessageId.size === 0) return;

    const rows = await this.db.message.findMany({
      where: { id: { in: [...mediaByMessageId.keys()] } },
      select: { id: true, mediaUrl: true, mediaThumbnailUrl: true },
    });
    for (const row of rows) {
      const media = mediaByMessageId.get(row.id);
      if (!media) continue;
      media.url = row.mediaUrl ?? null;
      media.thumbnail_url = row.mediaThumbnailUrl ?? null;
    }
  }

  /**
   * Stamp the full contact + conversation (status, unread, hydrated assignee)
   * onto every `message.sent` envelope. The mapper emits these `null` because
   * it can't query; an outbound-webhook receiver needs the same contact +
   * assignment context that `message.received` already carries, so one n8n
   * branch can handle both directions. One conversation read per distinct
   * conversation in the batch (≤1 in practice).
   */
  private async enrichSentMessageContext(
    envelopes: Array<{ type: PublicEventType; envelope: { data: unknown } }>,
  ): Promise<void> {
    type SentConversation = {
      id: string;
      contact_id: string;
      status: string | null;
      unread_count: number | null;
      last_message_at: string;
      assignee: AssigneeInfo | null;
    };
    type SentData = { contact: PublicContact | null; conversation: SentConversation };

    const byConversation = new Map<string, SentData[]>();
    for (const { type, envelope } of envelopes) {
      if (type !== "message.sent") continue;
      const data = envelope.data as SentData;
      const id = data.conversation?.id;
      if (!id) continue;
      const list = byConversation.get(id) ?? [];
      list.push(data);
      byConversation.set(id, list);
    }
    if (byConversation.size === 0) return;

    const rows = await this.db.conversation.findMany({
      where: { id: { in: [...byConversation.keys()] } },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    for (const row of rows) {
      const targets = byConversation.get(row.id);
      if (!targets) continue;
      const ext = conversationRowToExternal(row);
      const contact = externalContactToPublic(ext.contact);
      const conversation: SentConversation = {
        id: ext.id,
        contact_id: ext.contactId,
        status: ext.status,
        unread_count: ext.unreadCount,
        last_message_at: ext.lastMessageAt,
        assignee: ext.assignee
          ? { type: "user", id: ext.assignee.id, name: ext.assignee.name, email: ext.assignee.email }
          : null,
      };
      for (const data of targets) {
        data.contact = contact;
        data.conversation = conversation;
      }
    }
  }

  /**
   * Fill display names (and emails, for assignees) on every user reference the
   * mapper left id-only — one batched `user.findMany` across all envelopes:
   *   - `conversation.assignee` on message.received (mapper emits id only)
   *   - `previous_assignee` / `assignee` on conversation.assigned
   *   - `message.sender` on outbound agent sends ("who sent it")
   * Skips refs already hydrated (e.g. the conversation.assignee on message.sent,
   * which `enrichSentMessageContext` filled with name+email from the include).
   */
  private async hydrateUsers(
    envelopes: Array<{ envelope: { data: unknown } }>,
  ): Promise<void> {
    type UserRef = { type?: string; id?: string | null; name?: string | null; email?: string | null };
    const refs: Array<{ ref: UserRef; withEmail: boolean }> = [];
    const collect = (ref: UserRef | null | undefined, withEmail: boolean) => {
      // Only `user`-typed refs map to a User row; `ai_agent` lives elsewhere
      // (future), `contact` / `api` / `workflow` have no name to hydrate.
      if (!ref || !ref.id || ref.type !== "user" || ref.name != null) return;
      refs.push({ ref, withEmail });
    };
    for (const { envelope } of envelopes) {
      const data = envelope.data as {
        message?: { sender?: UserRef };
        conversation?: { assignee?: UserRef | null };
        assignee?: UserRef | null;
        previous_assignee?: UserRef | null;
      };
      collect(data.message?.sender, false);
      collect(data.conversation?.assignee, true);
      collect(data.assignee, true);
      collect(data.previous_assignee, true);
    }
    if (refs.length === 0) return;

    const ids = Array.from(new Set(refs.map((r) => r.ref.id as string)));
    const users = await this.db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const { ref, withEmail } of refs) {
      const u = byId.get(ref.id as string);
      if (!u) continue;
      ref.name = u.name;
      if (withEmail) ref.email = u.email;
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

    const conn = await this.db.channelConnection.findUnique({
      where: { teamId_provider: { teamId, provider: "meta_cloud" } },
      select: { config: true },
    });
    if (!conn) return null;
    const config = (conn.config ?? {}) as {
      phoneNumberId?: string;
      displayPhoneNumber?: string;
    };

    const channel: ChannelInfo = {
      source: "meta_cloud",
      phone_number_id: config.phoneNumberId ?? null,
      display_phone_number: config.displayPhoneNumber ?? null,
    };
    this.channelCache.set(teamId, channel);
    return channel;
  }
}

/**
 * Adapt the camelCase `ExternalContact` (already normalized: tagIds resolved,
 * customFields coerced, createdAt ISO) to the snake_case `PublicContact` wire
 * shape webhooks use. Pure — reuses the canonical /v1 serializer for the
 * heavy lifting so this is just a key rename.
 */
function externalContactToPublic(c: ExternalContact): PublicContact {
  return {
    id: c.id,
    phone_number: c.phoneNumber,
    name: c.name,
    first_name: c.firstName,
    last_name: c.lastName,
    language: c.language,
    country_code: c.countryCode,
    avatar_url: c.avatarUrl,
    email: c.email,
    location: c.location,
    stage_id: c.stageId,
    tag_ids: c.tagIds,
    custom_fields: c.customFields,
    created_at: c.createdAt,
  };
}
