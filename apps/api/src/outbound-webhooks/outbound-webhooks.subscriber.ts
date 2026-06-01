import { randomUUID } from "node:crypto";

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Channel as ChannelMedium } from "@prisma/client";

import { subscribe, SubscriberPriority } from "@/lib/events/bus";
import type {
  AssigneeInfo,
  PublicContact,
  PublicEventType,
  WireChannelBase,
} from "@ccp/shared/outbound-webhooks/public-events";
import {
  busEventTypesToSubscribe,
  channelSourceFor,
  toPublicEnvelopes,
  toWirePayload,
} from "@ccp/shared/outbound-webhooks/public-events";

import { DbService } from "../db/db.service";
import { runWithConcurrency } from "../common/concurrency";
import { getChainDepth, getCorrelationId } from "../common/correlation";
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
 * reflected in the outbound payload (close summary, firstResponseAt). That
 * order is now FIXED by `SubscriberPriority.OUTBOUND_WEBHOOKS` (the highest
 * tier), so it holds regardless of module import / registration order — a
 * reorder of `AppModule.imports` can no longer silently break it.
 *
 * Failures here MUST NOT throw to the bus — the per-handler try/catch in
 * `bus.ts` already isolates a thrown handler, but we want to log + carry on
 * with subsequent webhooks even when one match fails to persist.
 */
@Injectable()
export class OutboundWebhooksSubscriber implements OnModuleInit, OnModuleDestroy {
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
  private readonly channelCache = new Map<string, WireChannelBase>();

  constructor(private readonly db: DbService) {}

  // Captured unsubscribe fns so a programmatic re-init (test harness /
  // hot-reload) can't layer duplicate handlers on the bus's per-process
  // global. See WorkflowSubscribersService for the parallel posture.
  private offs: Array<() => void> = [];

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;

    for (const eventType of busEventTypesToSubscribe()) {
      this.offs.push(
        subscribe(
          eventType,
          async (event) => {
            try {
              await this.handle(event);
            } catch (err) {
              this.logger.error(
                `outbound-webhook dispatch failed for ${eventType}: ${
                  err instanceof Error ? err.message : err
                }`,
              );
            }
          },
          SubscriberPriority.OUTBOUND_WEBHOOKS,
        ),
      );
    }
    // Cache invalidator: a team-catalog change is the closest reliable
    // signal that the Meta phone number (the only team-row field we cache)
    // may have changed. Drop the row so the next event re-reads from DB.
    this.offs.push(
      subscribe(
        "team.catalog_changed",
        (event) => {
          if (this.channelCache.has(event.teamId)) {
            this.channelCache.delete(event.teamId);
          }
        },
        SubscriberPriority.OUTBOUND_WEBHOOKS,
      ),
    );
    this.logger.log(
      `Outbound webhook subscriber registered for ${busEventTypesToSubscribe().length} event types`,
    );
  }

  onModuleDestroy(): void {
    for (const off of this.offs) {
      try {
        off();
      } catch (err) {
        this.logger.warn(
          `unsubscribe failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    this.offs = [];
    this.registered = false;
  }

  private async handle(event: {
    teamId: string;
    type: string;
    silent?: boolean;
    skipOutboundWebhook?: boolean;
  }) {
    // Webhook delivery is gated by `skipOutboundWebhook`, which DEFAULTS to
    // `silent` when unset. So:
    //   - /v1 partner mutation (silent: true, flag unset) → skipped (no echo
    //     back to the partner that caused the change).
    //   - workflow STEP-driven change (silent: true for loop safety, but
    //     skipOutboundWebhook: false) → delivered, because partners DID
    //     subscribe to "On Contact Tag/Lifecycle changed" and a workflow that
    //     moves a contact's pipeline is exactly the signal they want.
    // The two concerns (skip workflow re-trigger vs skip webhook echo) used to
    // share one `silent` flag; splitting them is what lets a step be loop-safe
    // AND partner-visible. Socket fanout + audit + analytics still ran upstream.
    const skipWebhook = event.skipOutboundWebhook ?? event.silent ?? false;
    if (skipWebhook) return;

    // Capture the correlation id of the request that CAUSED this event NOW —
    // we're still synchronous within the publish() call chain, so the ALS scope
    // of the originating HTTP request is intact. The BullMQ delivery worker runs
    // later, outside that scope, so it can't read this itself. Persisted on the
    // delivery row + echoed as X-CCP-Trace-Id. Undefined for events published
    // outside an HTTP request (sweepers, boot reconciler). F6 in
    // docs/architecture-review-2026-05-25.md.
    const correlationId = getCorrelationId() ?? null;
    // Capture the inbound chain depth in the SAME synchronous ALS scope as the
    // correlation id (the BullMQ worker runs later, outside this scope). The
    // worker stamps depth+1 on the outbound POST so a partner that bounces our
    // webhook back into /v1 carries an incrementing counter that trips at
    // MAX_CHAIN_DEPTH. 0 for events with no HTTP origin (sweepers, ingest).
    const chainDepth = getChainDepth();

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
    // couldn't derive (it has no DB access). Best-effort: a failed lookup must
    // leave the documented `null` in place rather than DROP THE DELIVERY. Each
    // enrichment is independently try/caught — without this, a single rejected
    // Prisma findMany (pool flap, lock-wait timeout) anywhere in the chain threw
    // out of handle() and silently lost every webhook delivery for this publish.
    // The downstream `toWirePayload` already tolerates the un-enriched (null)
    // shape, so degrading is strictly better than dropping.
    //   1. media CDN urls on file messages (image/video/doc links)
    //   2. full contact + conversation (status, assignee) on message.sent so
    //      it matches message.received's context
    //   3. assignee + sender display names / emails wherever they're id-only
    try {
      await this.enrichMessages(envelopes);
    } catch (err) {
      this.logger.warn(
        `enrichMessages failed, delivering un-enriched: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await this.enrichSentMessageContext(envelopes);
    } catch (err) {
      this.logger.warn(
        `enrichSentMessageContext failed, delivering un-enriched: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await this.hydrateUsers(envelopes);
    } catch (err) {
      this.logger.warn(
        `hydrateUsers failed, delivering un-enriched: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Channel is derived from the event itself (message/contact/conversation),
    // so a Telegram/Instagram event stamps its own connection — not WhatsApp.
    // Also degrade-on-failure: a null channelBase is tolerated by toWirePayload.
    let channelBase: Awaited<ReturnType<typeof this.resolveChannel>> | null = null;
    try {
      channelBase = await this.resolveChannel(
        event.teamId,
        deriveEventChannel(event as unknown as Record<string, unknown>),
      );
    } catch (err) {
      this.logger.warn(
        `resolveChannel failed, delivering without channel: ${err instanceof Error ? err.message : err}`,
      );
    }

    for (const { type, envelope } of envelopes) {
      const matching = webhooks.filter((w) => w.eventTypes.includes(type));
      if (matching.length === 0) continue;

      // Internal enriched envelope → flat wire shape (partner-compatible).
      // Identical for every webhook subscribed to this type; dedup id rides
      // on the X-CCP-Delivery header (= delivery row id), not the body.
      // `team_id` is stamped here (not inside toWirePayload's per-type cases)
      // so a multi-tenant partner pointing one URL at several teams can route
      // by team from the body — the flat shape otherwise omits it.
      const payload = {
        team_id: event.teamId,
        ...toWirePayload(type, (envelope as { data: unknown }).data, { channelBase }),
      };

      // Bounded fan-out (DB insert + BullMQ enqueue per matching webhook).
      // Was two unbounded `Promise.all`s; a team subscribing many webhooks
      // to a chatty event (e.g. a 30-message Meta batch hitting 4-5 webhooks
      // at once) released hundreds of parallel Prisma inserts at once,
      // which pins the pool slot until the slowest finishes. 8 lanes
      // bounds the burst without lengthening tail latency meaningfully.
      //
      // Two layers of error isolation, fixing a cascade the original
      // `Promise.all`+`runWithConcurrency` combo silently inherited:
      //   1. PER-WEBHOOK try/catch — one delivery row failing (pool flap,
      //      partial unique conflict, etc.) MUST NOT kill its 7 lane-mates'
      //      writes in the same envelope. Previously a single throw
      //      aborted every lane via `runWithConcurrency`'s rejection.
      //   2. PER-ENVELOPE try/catch — if `runWithConcurrency` itself
      //      throws for any reason, the `for (envelopes)` loop must still
      //      proceed to the next envelope TYPE. Otherwise a hiccup on
      //      `message.received` deliveries would drop the same publish's
      //      `contact.updated` / `contact.tag_changed` deliveries too.
      // Enqueue is inside the same per-webhook block so a successful
      // create-then-failed-enqueue is still logged but the orphan row is
      // bounded (operator can re-enqueue or sweeper will GC).
      try {
        await runWithConcurrency(matching, 8, async (w) => {
          const deliveryId = randomUUID();
          try {
            await this.db.outboundWebhookDelivery.create({
              data: {
                id: deliveryId,
                webhookId: w.id,
                eventType: type,
                correlationId,
                payload: payload as unknown as Parameters<
                  typeof this.db.outboundWebhookDelivery.create
                >[0]["data"]["payload"],
              },
              select: { id: true },
            });
          } catch (createErr) {
            this.logger.error(
              `delivery create failed for webhook=${w.id} type=${type}: ${
                createErr instanceof Error ? createErr.message : createErr
              }`,
            );
            return;
          }
          try {
            await enqueueWebhookDelivery(deliveryId, chainDepth);
          } catch (err) {
            this.logger.error(
              `enqueue failed for delivery ${deliveryId}: ${err instanceof Error ? err.message : err}`,
            );
          }
        });
      } catch (envelopeErr) {
        this.logger.error(
          `outbound-webhook envelope fanout failed for type=${type}: ${
            envelopeErr instanceof Error ? envelopeErr.message : envelopeErr
          }`,
        );
      }
    }
  }

  /**
   * Enrich message-bearing envelopes from the DB in one batched lookup:
   *   - `external_id` (the provider wamid → `channelMessageId` on the wire)
   *   - `media.url` + `media.thumbnail_url` (public CDN links) on file messages
   * One query across all messages in the event (≤2 in practice). Best-effort:
   * a missing row leaves the documented nulls in place.
   */
  private async enrichMessages(
    envelopes: Array<{ envelope: { data: unknown } }>,
  ): Promise<void> {
    type MediaShape = { url: string | null; thumbnail_url: string | null };
    type MsgShape = { id?: string; external_id?: string | null; media?: MediaShape | null };
    type MsgData = { message?: MsgShape };

    const messagesById = new Map<string, MsgShape>();
    for (const { envelope } of envelopes) {
      const msg = (envelope.data as MsgData).message;
      if (msg?.id) messagesById.set(msg.id, msg);
    }
    if (messagesById.size === 0) return;

    const rows = await this.db.message.findMany({
      where: { id: { in: [...messagesById.keys()] } },
      select: { id: true, externalId: true, mediaUrl: true, mediaThumbnailUrl: true },
    });
    for (const row of rows) {
      const msg = messagesById.get(row.id);
      if (!msg) continue;
      msg.external_id = row.externalId ?? null;
      if (msg.media) {
        msg.media.url = row.mediaUrl ?? null;
        msg.media.thumbnail_url = row.mediaThumbnailUrl ?? null;
      }
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
    type UserRef = {
      type?: string;
      id?: string | null;
      name?: string | null;
      email?: string | null;
      role?: string | null;
      created_at?: string | null;
    };
    const refs: Array<{ ref: UserRef; withEmail: boolean }> = [];
    const collect = (ref: UserRef | null | undefined, withEmail: boolean) => {
      // Only `user`-typed refs map to a User row; `ai_agent` lives elsewhere
      // (future), `contact` / `api` / `workflow` have no name to hydrate.
      if (!ref || !ref.id || ref.type !== "user") return;
      // Senders need only a name (skip once set). Assignees need role +
      // created_at for the wire `assignee` block, so collect them until
      // `role` is filled — even when name was already set upstream (e.g.
      // message.sent's assignee, hydrated name-only by enrichSentMessageContext).
      if (withEmail ? ref.role !== undefined : ref.name != null) return;
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
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const { ref, withEmail } of refs) {
      const u = byId.get(ref.id as string);
      if (!u) continue;
      ref.name = u.name;
      if (withEmail) {
        ref.email = u.email;
        // Powers the wire `assignee` block (role + created_at).
        ref.role = u.role;
        ref.created_at = u.createdAt.toISOString();
      }
    }
  }

  /**
   * Resolve a team's ChannelConnection into a public ChannelInfo, keyed by the
   * EVENT's channel (not hardcoded). The channel medium is derived per-event
   * from the data already in the payload (`deriveEventChannel`), so a Telegram
   * message's webhook stamps the Telegram connection, not WhatsApp's. Cached
   * per `(teamId, channel)` for the process lifetime — connections rarely
   * change; cache is invalidated wholesale on `team.catalog_changed`.
   *
   * `channel = null` (the event carried no derivable channel — e.g. a future
   * channel-less event) falls back to the team's first active connection so
   * the channel block degrades to "the team's primary channel" rather than
   * disappearing. Today that's WhatsApp; it's no longer assumed.
   */
  private async resolveChannel(
    teamId: string,
    channel: ChannelMedium | null,
  ): Promise<WireChannelBase | null> {
    const key = `${teamId}:${channel ?? "_primary"}`;
    const cached = this.channelCache.get(key);
    if (cached) return cached;

    const conn = channel
      ? await this.db.channelConnection.findUnique({
          where: { teamId_channel: { teamId, channel } },
          select: { id: true, channel: true, createdAt: true },
        })
      : await this.db.channelConnection.findFirst({
          where: { teamId, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true, channel: true, createdAt: true },
        });
    if (!conn) return null;

    const base: WireChannelBase = {
      id: conn.id,
      // `name` is the medium itself ("whatsapp" | "telegram" | "instagram");
      // `source` is the partner-style "<medium>_business" string.
      name: conn.channel,
      source: channelSourceFor(conn.channel),
      created_at: Math.floor(conn.createdAt.getTime() / 1000),
    };
    this.channelCache.set(key, base);
    return base;
  }
}

/**
 * Derive the channel medium an event belongs to from data already on the
 * payload — no DB read. Every webhook-relevant event carries the channel
 * either directly on its message (`Message.channel`), on a workflow snapshot
 * (`WorkflowMessageSnapshot.channel` / `WorkflowConversationSnapshot.channel`),
 * or on the contact (`identityChannel`, NOT NULL post-2026-05-25, and equal to
 * the conversation's channel because contacts are siloed per channel). Returns
 * null only for events that genuinely carry no channel reference (the resolver
 * then falls back to the team's primary connection).
 */
function deriveEventChannel(event: Record<string, unknown>): ChannelMedium | null {
  const message = event.message as { channel?: ChannelMedium } | undefined;
  if (message?.channel) return message.channel;
  const workflowMessage = event.workflowMessage as { channel?: ChannelMedium } | undefined;
  if (workflowMessage?.channel) return workflowMessage.channel;
  const conversation = event.conversation as { channel?: ChannelMedium } | undefined;
  if (conversation?.channel) return conversation.channel;
  const contact = event.contact as { identityChannel?: ChannelMedium | null } | undefined;
  if (contact?.identityChannel) return contact.identityChannel;
  return null;
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
