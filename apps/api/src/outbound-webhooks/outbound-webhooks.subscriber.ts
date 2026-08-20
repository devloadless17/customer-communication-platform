import { randomUUID } from "node:crypto";

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Channel as ChannelMedium } from "@prisma/client";

import { toExternalMediaUrl } from "@/lib/blob-storage";
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
import { actorNameMasker } from "@/lib/workspaces/operator-mask";
import { runWithConcurrency } from "../common/concurrency";
import { getChainDepth, getCorrelationId, getOutboxDispatchId } from "../common/correlation";
import { enqueueWebhookDelivery } from "@/lib/outbound-webhooks/queue";
import { WEBHOOK_WIRE_VERSION } from "@/lib/outbound-webhooks/signing";
import {
  EXTERNAL_CONVERSATION_INCLUDE,
  conversationRowToExternal,
  type ExternalContact,
} from "@/lib/external-shapes";

/**
 * Bus subscriber that fans each allowlisted DomainEvent out to every
 * matching `OutboundWebhook` row for the event's team.
 *
 *   1. Filter: SQL-side lookup by `workspaceId` + `eventTypes` array contains.
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
/** Everything the wire `channel` block needs about an account. One definition
 *  so the three resolution branches below cannot drift in what they select. */
const ACCOUNT_IDENTITY_SELECT = {
  id: true,
  channel: true,
  createdAt: true,
  label: true,
  externalAccountId: true,
  config: true,
} as const;


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
          // Cache keys are `${workspaceId}:${channel|_primary}` (resolveChannel),
          // NOT the bare team id — so we must drop every key PREFIXED with this
          // team's id, not look up `event.workspaceId` directly (which never hits).
          // Otherwise a team that disconnects/reconnects WhatsApp keeps stamping
          // the stale ChannelConnection id until the process restarts.
          const prefix = `${event.workspaceId}:`;
          for (const key of this.channelCache.keys()) {
            if (key.startsWith(prefix)) this.channelCache.delete(key);
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
    workspaceId: string;
    type: string;
    silent?: boolean;
    skipOutboundWebhook?: boolean;
  }) {
    // Webhook delivery is gated by `skipOutboundWebhook`, which DEFAULTS to
    // `silent` when unset. So:
    //   - /v1 partner mutation: `silent` follows the request's own
    //     `silent` field and DEFAULTS TO FALSE — so /v1 mutations DO echo to
    //     webhooks (including the causing partner's) unless the caller opts
    //     into silent. Loop safety comes from X-CCP-Origin-Key + the
    //     X-CCP-Depth cap, not from a skip here. (Comment corrected
    //     2026-08-10 — it previously claimed a no-echo default that never
    //     existed.)
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
    // the 2026-07-29 verification round.
    const correlationId = getCorrelationId() ?? null;
    // Capture the inbound chain depth in the SAME synchronous ALS scope as the
    // correlation id (the BullMQ worker runs later, outside this scope). The
    // worker stamps depth+1 on the outbound POST so a partner that bounces our
    // webhook back into /v1 carries an incrementing counter that trips at
    // MAX_CHAIN_DEPTH. 0 for events with no HTTP origin (sweepers, ingest).
    const chainDepth = getChainDepth();
    // Stable across redeliveries of this outbox row (null on the sync publish
    // path) — see the per-delivery `eventKey` below.
    const dispatchId = getOutboxDispatchId();

    const envelopes = toPublicEnvelopes(event as Parameters<typeof toPublicEnvelopes>[0]);
    if (envelopes.length === 0) return;

    // Single SQL query per event for all matching public event names. Done
    // FIRST so we skip every enrichment lookup below when no webhook is
    // subscribed to this event for this team (the overwhelmingly common case).
    const publicTypes = Array.from(new Set(envelopes.map((e) => e.type)));
    const webhooks = await this.db.outboundWebhook.findMany({
      where: {
        workspaceId: event.workspaceId,
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
      await this.enrichMessages(event.workspaceId, envelopes);
    } catch (err) {
      this.logger.warn(
        `enrichMessages failed, delivering un-enriched: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await this.enrichSentMessageContext(event.workspaceId, envelopes);
    } catch (err) {
      this.logger.warn(
        `enrichSentMessageContext failed, delivering un-enriched: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await this.hydrateUsers(event.workspaceId, envelopes);
    } catch (err) {
      this.logger.warn(
        `hydrateUsers failed, delivering un-enriched: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await this.enrichLeanContacts(event.workspaceId, envelopes);
    } catch (err) {
      this.logger.warn(
        `enrichLeanContacts failed, delivering without contact: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Channel is derived from the event itself (message/contact/conversation),
    // so a Telegram/Instagram event stamps its own connection — not WhatsApp.
    // Also degrade-on-failure: a null channelBase is tolerated by toWirePayload.
    let channelBase: Awaited<ReturnType<typeof this.resolveChannel>> | null = null;
    try {
      // One cast, read twice — the medium and the ACCOUNT are both derived
      // from the same payload.
      const raw = event as unknown as Record<string, unknown>;
      channelBase = await this.resolveChannel(
        event.workspaceId,
        deriveEventChannel(raw),
        await this.resolveEventAccountId(event.workspaceId, raw),
      );
    } catch (err) {
      this.logger.warn(
        `resolveChannel failed, delivering without channel: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Workspace-level AI Autopilot opt-in. Folded into the wire `ai_enabled`
    // (team-on AND conversation-on) so an org with the feature OFF reports
    // ai_enabled:false on EVERY conversation regardless of the per-conversation
    // flag. Resolved fresh (not cached) so an admin toggling the setting in
    // Settings takes effect on the very next inbound. Cheap indexed PK lookup;
    // degrade-to-false on error (fail safe — don't let the AI run if unknown).
    // `firstTouchGreeter` rides the same lookup — it drives suppressing the AI
    // on a brand-new conversation's first inbound (see toWirePayload). Default
    // "ai" (no suppression) on any error so a lookup hiccup can't silence the AI.
    let teamAiAutopilotEnabled = false;
    let firstTouchGreeter: "ai" | "workflow" = "ai";
    try {
      const t = await this.db.workspace.findUnique({
        where: { id: event.workspaceId },
        select: { aiAutopilotEnabled: true, firstTouchGreeter: true },
      });
      teamAiAutopilotEnabled = t?.aiAutopilotEnabled ?? false;
      firstTouchGreeter = t?.firstTouchGreeter ?? "ai";
    } catch (err) {
      this.logger.warn(
        `resolve team aiAutopilot failed, treating as off: ${err instanceof Error ? err.message : err}`,
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
      // Event occurred-at (epoch ms) — stamped for EVERY event so a partner can
      // order/age events instead of relying on receipt time. Sourced from the
      // envelope's occurred_at (previously internal-only, exposed to no one).
      // Placed BEFORE the spread so message.status_changed's per-case `timestamp`
      // (the precise transition time) still wins for that one event.
      const occurredAtRaw = (envelope as { occurred_at?: string }).occurred_at;
      const occurredAtMs = occurredAtRaw ? Date.parse(occurredAtRaw) : NaN;
      const payload = {
        // Wire schema version — stamped in the BODY (not just the
        // X-CCP-Webhook-Version header) so body-only consumers (n8n/Zapier)
        // can branch on it. A future v2 envelope bumps this; v1 is frozen.
        v: WEBHOOK_WIRE_VERSION,
        team_id: event.workspaceId,
        timestamp: Number.isNaN(occurredAtMs) ? null : occurredAtMs,
        ...toWirePayload(type, (envelope as { data: unknown }).data, {
          channelBase,
          teamAiAutopilotEnabled,
          firstTouchGreeter,
        }),
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
          // Redelivery dedupe (2026-07-27). The outbox is at-least-once, and
          // `deliveryId` is BOTH our BullMQ jobId and the partner's
          // X-CCP-Delivery dedup header — so minting a fresh UUID on a
          // redelivered event defeated dedupe on both sides: we re-enqueued,
          // and the partner saw a second POST with a different event_id it
          // could not correlate. Keyed per (outbox row, webhook); null on the
          // sync publish path, which never redelivers.
          const eventKey = dispatchId ? `${dispatchId}:${w.id}:${type}` : null;
          try {
            await this.db.outboundWebhookDelivery.create({
              data: {
                id: deliveryId,
                webhookId: w.id,
                eventType: type,
                ...(eventKey ? { eventKey } : {}),
                correlationId,
                // (see the payload spread below — event_id is per-DELIVERY)
                // minor#8: persist the chain depth on the row so the orphan
                // sweeper's re-enqueue preserves the loop-guard counter (it only
                // has the row, not the original BullMQ job arg).
                chainDepth,
                // `event_id` is the DELIVERY row id — the same value that rides
                // on the X-CCP-Delivery header, so the two agree and a partner
                // can dedupe from either. It lives per-delivery (not on the
                // shared `payload` built once per envelope) because each
                // matching webhook gets its own delivery row and its own id.
                //
                // Header-only was a real gap: several no-code receivers (Zapier
                // Catch Hook, some n8n configurations) expose the BODY and not
                // the request headers, leaving those partners with no dedup key
                // at all on an at-least-once delivery contract.
                payload: { ...payload, event_id: deliveryId } as unknown as Parameters<
                  typeof this.db.outboundWebhookDelivery.create
                >[0]["data"]["payload"],
              },
              select: { id: true },
            });
          } catch (createErr) {
            // P2002 on eventKey = this outbox row already created (and
            // enqueued) this webhook's delivery. A redelivery must NOT
            // re-POST the partner.
            if (
              createErr instanceof Prisma.PrismaClientKnownRequestError &&
              createErr.code === "P2002"
            ) {
              return;
            }
            this.logger.error(
              `delivery create failed for webhook=${w.id} type=${type}: ${
                createErr instanceof Error ? createErr.message : createErr
              }`,
            );
            return;
          }
          try {
            // Carry workspaceId so the worker's per-team gate reads it off the job
            // (no per-pickup DB findUnique). All webhooks here belong to
            // event.workspaceId (queried by it above).
            await enqueueWebhookDelivery(deliveryId, chainDepth, event.workspaceId);
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
   *   - `reply_to` quote backfill for /v1-origin sends (the mapper only fills
   *     it when the domain message carried the JOINed ReplySnapshot; an external
   *     send carries only `replyToMessageId`, so the wire `reply_to` would be
   *     null even though the message IS a reply — see (VII)).
   * One query across all messages in the event (≤2 in practice), plus at most
   * one extra `findMany` for the quoted rows. Best-effort: a missing row leaves
   * the documented nulls in place.
   */
  private async enrichMessages(
    workspaceId: string,
    envelopes: Array<{ envelope: { data: unknown } }>,
  ): Promise<void> {
    type MediaShape = { url: string | null; thumbnail_url: string | null };
    type ReplyShape = {
      message_id: string;
      body: string;
      direction: string;
      sender_name: string | null;
      media_kind: string | null;
    };
    type MsgShape = {
      id?: string;
      external_id?: string | null;
      media?: MediaShape | null;
      reply_to?: ReplyShape | null;
    };
    type MsgData = { message?: MsgShape };

    const messagesById = new Map<string, MsgShape>();
    for (const { envelope } of envelopes) {
      const msg = (envelope.data as MsgData).message;
      if (msg?.id) messagesById.set(msg.id, msg);
    }
    if (messagesById.size === 0) return;

    const rows = await this.db.message.findMany({
      where: { workspaceId, id: { in: [...messagesById.keys()] } },
      select: {
        id: true,
        externalId: true,
        mediaUrl: true,
        mediaThumbnailUrl: true,
        // (VII) — drives the quote backfill below. Only a /v1-origin send leaves
        // `reply_to` unset on the envelope while this column is populated.
        replyToMessageId: true,
      },
    });
    // Collect quoted-message ids whose envelope is missing the `reply_to` block.
    const quotedIdToTargets = new Map<string, MsgShape[]>();
    for (const row of rows) {
      const msg = messagesById.get(row.id);
      if (!msg) continue;
      msg.external_id = row.externalId ?? null;
      if (msg.media) {
        // Presign into fetchable URLs — the stored urls point at the PRIVATE R2
        // bucket (403 for the webhook receiver). See toExternalMediaUrl. A
        // slow-upload row still null here is filled + presigned later by the
        // worker's resolvePendingMediaUrl.
        msg.media.url = await toExternalMediaUrl(row.mediaUrl);
        msg.media.thumbnail_url = await toExternalMediaUrl(row.mediaThumbnailUrl);
      }
      if (row.replyToMessageId && msg.reply_to == null) {
        const list = quotedIdToTargets.get(row.replyToMessageId) ?? [];
        list.push(msg);
        quotedIdToTargets.set(row.replyToMessageId, list);
      }
    }

    if (quotedIdToTargets.size === 0) return;
    // One batched load of the quoted rows. Mirrors the read-side reply snapshot:
    // body, direction, the authoring teammate's name (outbound only), mediaKind.
    const quotedRows = await this.db.message.findMany({
      where: { workspaceId, id: { in: [...quotedIdToTargets.keys()] } },
      select: {
        id: true,
        body: true,
        direction: true,
        mediaKind: true,
        senderUserId: true,
        sender: { select: { name: true } },
      },
    });
    // OPERATOR MASK (CLAUDE.md §18). This join carries no membership filter, so
    // it was the one webhook field that shipped the platform operator's REAL
    // name to a tenant's partner endpoint — the in-app twin lives in
    // `lib/queries/_shared.ts`.
    const maskName = await actorNameMasker(
      this.db,
      [workspaceId],
      quotedRows.map((q) => q.senderUserId),
    );
    for (const q of quotedRows) {
      const targets = quotedIdToTargets.get(q.id);
      if (!targets) continue;
      const reply: ReplyShape = {
        message_id: q.id,
        body: q.body,
        direction: q.direction === "out" ? "out" : "in",
        // Authoring teammate's name on an outbound quote; null on inbound
        // (the contact has no User row) — same convention as ReplySnapshot.
        sender_name:
          q.direction === "out" ? maskName(q.senderUserId, q.sender?.name) : null,
        media_kind: q.mediaKind ?? null,
      };
      for (const msg of targets) msg.reply_to = reply;
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
    workspaceId: string,
    envelopes: Array<{ type: PublicEventType; envelope: { data: unknown } }>,
  ): Promise<void> {
    type SentConversation = {
      id: string;
      contact_id: string;
      status: string | null;
      unread_count: number | null;
      last_message_at: string;
      assignee: AssigneeInfo | null;
      // camelCase to match what the wire mapper reads (d.conversation?.aiEnabled).
      aiEnabled: boolean;
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
      where: { workspaceId, id: { in: [...byConversation.keys()] } },
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
        aiEnabled: row.aiEnabled,
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
   *   - `note.author_user_id` on note.created → stamps `author_name` /
   *     `author_email` onto the note block (III) so the wire carries who wrote
   *     the comment, not just the id.
   * Skips refs already hydrated (e.g. the conversation.assignee on message.sent,
   * which `enrichSentMessageContext` filled with name+email from the include).
   */
  private async hydrateUsers(
    workspaceId: string,
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
    // (III) note.created's author is a flat id (not a {type,id} ref), so it gets
    // its own collection — stamped post-lookup onto author_name / author_email.
    type NoteShape = {
      author_user_id?: string | null;
      author_name?: string | null;
      author_email?: string | null;
    };
    const refs: Array<{ ref: UserRef; withEmail: boolean }> = [];
    const noteBlocks: NoteShape[] = [];
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
        note?: NoteShape;
      };
      collect(data.message?.sender, false);
      collect(data.conversation?.assignee, true);
      collect(data.assignee, true);
      collect(data.previous_assignee, true);
      if (data.note?.author_user_id) noteBlocks.push(data.note);
    }
    if (refs.length === 0 && noteBlocks.length === 0) return;

    const ids = Array.from(
      new Set([
        ...refs.map((r) => r.ref.id as string),
        ...noteBlocks.map((n) => n.author_user_id as string),
      ]),
    );
    const users = await this.db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } }, id: { in: ids } },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
      },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    // The membership filter above is what keeps a tenant's partner from
    // receiving a stranger's name and email — but it also meant an
    // operator-authored note or assignment shipped a bare `id` with NO name at
    // all, which is worse than either answer: an integration gets an actor it
    // can never resolve and no way to know why. Name them "Support", exactly as
    // the in-app surfaces do, and still withhold the email and the role (those
    // describe a member of the workspace, which the operator is not).
    const maskName = await actorNameMasker(this.db, [workspaceId], ids);
    for (const { ref, withEmail } of refs) {
      const u = byId.get(ref.id as string);
      if (!u) {
        const masked = maskName(ref.id as string, null);
        if (masked) ref.name = masked;
        continue;
      }
      ref.name = u.name;
      if (withEmail) {
        ref.email = u.email;
        // Powers the wire `assignee` block (role + created_at).
        ref.role = u.workspaceMemberships[0]?.role ?? "agent";
        ref.created_at = u.createdAt.toISOString();
      }
    }
    for (const note of noteBlocks) {
      const u = byId.get(note.author_user_id as string);
      if (!u) {
        // Same reasoning as the refs above — name the operator, withhold the
        // email (an address the tenant's partner has no business writing to).
        const masked = maskName(note.author_user_id as string, null);
        if (masked) note.author_name = masked;
        continue;
      }
      note.author_name = u.name;
      note.author_email = u.email;
    }
  }

  /**
   * (II) Stamp a LEAN contact block `{ id, phoneNumber, name }` onto every
   * non-message envelope that today carries only a contact/conversation id, so
   * a partner flow can route by the contact without a callback to /v1. Applies
   * to:
   *   - conversation.assigned / status_changed / opened / closed / ai_changed
   *     (`data.contact_id` on the envelope)
   *   - contact.tag_changed / contact.lifecycle_changed (`data.contact_id`)
   *   - note.created / note.deleted (only a conversation id is on the envelope,
   *     so resolve conversation → contactId first)
   *
   * Deliberately LEAN — no tags / customFields / stage (that's bloat; receivers
   * that want the full record call GET /v1/contacts/:id). Message events already
   * carry the full `contact` via enrichSentMessageContext / the inbound mapper,
   * so they're skipped here.
   *
   * Two batched reads at most: one conversation lookup (notes only) + one
   * contact lookup. Best-effort — a missing row just leaves `contact` absent.
   */
  private async enrichLeanContacts(
    workspaceId: string,
    envelopes: Array<{ type: PublicEventType; envelope: { data: unknown } }>,
  ): Promise<void> {
    type LeanContact = { id: string; phoneNumber: string | null; name: string };
    type LeanData = {
      contact_id?: string;
      conversation_id?: string;
      note?: { conversation_id?: string };
      contact?: LeanContact | null;
    };

    // contactId → envelope data blocks awaiting a lean contact stamp.
    const targetsByContactId = new Map<string, LeanData[]>();
    // For note events we only know the conversation id up front; resolve it to a
    // contactId in one batched lookup, then funnel into the same contact load.
    const targetsByConversationId = new Map<string, LeanData[]>();

    const pushContact = (contactId: string, data: LeanData) => {
      const list = targetsByContactId.get(contactId) ?? [];
      list.push(data);
      targetsByContactId.set(contactId, list);
    };
    const pushConversation = (conversationId: string, data: LeanData) => {
      const list = targetsByConversationId.get(conversationId) ?? [];
      list.push(data);
      targetsByConversationId.set(conversationId, list);
    };

    for (const { type, envelope } of envelopes) {
      const data = envelope.data as LeanData;
      switch (type) {
        case "conversation.assigned":
        case "conversation.status_changed":
        case "conversation.opened":
        case "conversation.closed":
        case "conversation.ai_changed":
        case "contact.tag_changed":
        case "contact.lifecycle_changed": {
          if (data.contact_id) pushContact(data.contact_id, data);
          break;
        }
        case "note.created": {
          const convId = data.note?.conversation_id;
          if (convId) pushConversation(convId, data);
          break;
        }
        case "note.deleted": {
          if (data.conversation_id) pushConversation(data.conversation_id, data);
          break;
        }
        case "ticket.changed": {
          // Same enrichment reason as the flag event below: without the
          // contact block a receiver has to call back just to learn WHO the
          // work is for — the exact round-trip this removes.
          if (data.conversation_id) pushConversation(data.conversation_id, data);
          break;
        }
        case "message.flag_changed": {
          // Without this the flag webhook ships `contact: null`, forcing every
          // receiver into a callback just to learn WHO complained — the exact
          // round-trip this enrichment exists to remove, and the opposite of
          // what the event promises ("route flagged work with no extra call").
          if (data.conversation_id) pushConversation(data.conversation_id, data);
          break;
        }
        default:
          break;
      }
    }

    if (targetsByConversationId.size > 0) {
      const convs = await this.db.conversation.findMany({
        where: { workspaceId, id: { in: [...targetsByConversationId.keys()] } },
        select: { id: true, contactId: true },
      });
      for (const c of convs) {
        const list = targetsByConversationId.get(c.id);
        if (!list) continue;
        for (const data of list) pushContact(c.contactId, data);
      }
    }

    if (targetsByContactId.size === 0) return;
    const contacts = await this.db.contact.findMany({
      where: { workspaceId, id: { in: [...targetsByContactId.keys()] } },
      select: { id: true, phoneNumber: true, name: true },
    });
    for (const row of contacts) {
      const list = targetsByContactId.get(row.id);
      if (!list) continue;
      const lean: LeanContact = {
        id: row.id,
        phoneNumber: row.phoneNumber ?? null,
        name: row.name,
      };
      for (const data of list) data.contact = lean;
    }
  }

  /**
   * WHICH account the event belongs to — payload first, conversation second.
   *
   * `deriveEventAccountId` is the fast path and covers the events whose payload
   * already carries the account. It does NOT cover all of them: of the ten
   * conversation-scoped public events, only `message.received`,
   * `conversation.assigned` and `conversation.status_changed` carry a
   * conversation snapshot. `message.sent`, `message.status_changed`,
   * `conversation.ai_changed`, `note.*`, `message.flag_changed` and
   * `ticket.changed` do not — and for those the resolver fell back to the
   * workspace DEFAULT connection, i.e. reported the wrong number.
   *
   * Rather than thread the field onto seven more event types and roughly twenty
   * publish sites — where missing ONE reintroduces the bug silently, which is
   * exactly how this class started — every one of them already carries
   * `conversationId`, and the conversation is the single owner of the account.
   * So fall back to reading it. One indexed lookup (the FK index added in
   * migration 20260728100000), only for events that need it, and it cannot go
   * stale the way a cached mapping would when ingest re-stamps a thread.
   */
  private async resolveEventAccountId(
    workspaceId: string,
    raw: Record<string, unknown>,
  ): Promise<string | null> {
    // A MESSAGE event's account is a fact about the PAST — which of our numbers
    // actually carried it. Prefer the message's own stamp over the conversation
    // pointer, which ingest re-stamps whenever the customer writes to a
    // different number of ours: that rewrote history for `message.sent` and
    // `message.status_changed`, so a partner saw a send that genuinely went out
    // from Sales reported under Support.
    //
    // Resolved HERE, in the one place, rather than threading the field onto the
    // ~20 publish sites — missing one there silently reintroduces the bug,
    // which is how this whole class started (see deriveEventAccountId).
    // TWO SHAPES, and reading only one of them is what made this branch dead
    // for the event that needed it most. `message.status_changed` and
    // `message.flag_changed` carry a TOP-LEVEL `messageId`; `message.sent` and
    // `message.received` carry the whole `Message` DTO instead, so their id is
    // at `message.id` and there is no top-level field to read. With only the
    // top-level lookup, `message.sent` — the single most-subscribed outbound
    // event — always fell through to the conversation pointer, i.e. straight
    // back into the bug this branch exists to prevent.
    const nestedMessage = raw.message as { id?: unknown } | undefined;
    const messageId =
      typeof raw.messageId === "string" && raw.messageId ? raw.messageId : nestedMessage?.id;
    if (typeof messageId === "string" && messageId) {
      // workspaceId stays in the WHERE — the id arrives on an event payload.
      const msg = await this.db.message.findFirst({
        where: { id: messageId, workspaceId },
        select: { channelConnectionId: true },
      });
      // Null means a row written before the column existed; fall through to the
      // conversation pointer, which is exactly the previous behaviour.
      if (msg?.channelConnectionId) return msg.channelConnectionId;
    }
    const carried = deriveEventAccountId(raw);
    if (carried) return carried;
    const conversationId = raw.conversationId;
    if (typeof conversationId !== "string" || !conversationId) return null;
    // workspaceId stays in the WHERE — the id arrives on an event payload.
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, workspaceId },
      select: { channelConnectionId: true },
    });
    return conv?.channelConnectionId ?? null;
  }

  /**
   * Resolve a team's ChannelConnection into a public ChannelInfo, keyed by the
   * EVENT's channel (not hardcoded). The channel medium is derived per-event
   * from the data already in the payload (`deriveEventChannel`), so a Telegram
   * message's webhook stamps the Telegram connection, not WhatsApp's. Cached
   * per `(workspaceId, channel)` for the process lifetime — connections rarely
   * change; cache is invalidated wholesale on `team.catalog_changed`.
   *
   * `channel = null` (the event carried no derivable channel — e.g. a future
   * channel-less event) falls back to the team's first active connection so
   * the channel block degrades to "the team's primary channel" rather than
   * disappearing. Today that's WhatsApp; it's no longer assumed.
   */
  private async resolveChannel(
    workspaceId: string,
    channel: ChannelMedium | null,
    /**
     * The account the event ACTUALLY belongs to (`deriveEventAccountId`).
     * Preferred over the channel default whenever the event carries it — see
     * that helper for what reporting the default instead cost partners.
     * Still workspace-scoped in the WHERE: the id rides on an event payload,
     * so scoping by id alone would let a mis-stamped row surface another
     * tenant's connection.
     */
    accountId?: string | null,
  ): Promise<WireChannelBase | null> {
    const key = `${workspaceId}:${accountId ?? channel ?? "_primary"}`;
    const cached = this.channelCache.get(key);
    if (cached) return cached;

    const conn = accountId
      ? await this.db.channelConnection.findFirst({
          where: { id: accountId, workspaceId },
          select: ACCOUNT_IDENTITY_SELECT,
        })
      : channel
      ? await this.db.channelConnection.findFirst({
          where: { workspaceId, channel, isDefault: true },
          select: ACCOUNT_IDENTITY_SELECT,
        })
      : await this.db.channelConnection.findFirst({
          where: { workspaceId, isActive: true },
          orderBy: { createdAt: "asc" },
          select: ACCOUNT_IDENTITY_SELECT,
        });
    if (!conn) {
      // A KNOWN medium with no `ChannelConnection` row — first-party channels
      // (webchatwidget) keep their config in a dedicated table, not
      // ChannelConnection. Still emit a channel block so the wire payload
      // identifies the medium (id/created_at legitimately null — the channel has
      // no single connection) instead of a null `channel`, matching every other
      // live channel. Only a genuinely channel-less event (channel == null with
      // no primary connection at all) stays null.
      if (channel) {
        const synthetic: WireChannelBase = {
          id: null,
          name: channel,
          source: channelSourceFor(channel),
          created_at: null,
          // No ChannelConnection row exists for this medium, so there is no
          // account identity to report — null, exactly like `id`.
          account_label: null,
          account_address: null,
          account_external_id: null,
          // Not a fallback — this medium HAS no ChannelConnection to guess at.
          account_is_default_fallback: false,
        };
        this.channelCache.set(key, synthetic);
        return synthetic;
      }
      return null;
    }

    const base: WireChannelBase = {
      id: conn.id,
      // `name` is the medium itself ("whatsapp" | "telegram" | "instagram");
      // `source` is the partner-style "<medium>_business" string.
      name: conn.channel,
      source: channelSourceFor(conn.channel),
      // Epoch MS, consistent with every other wire timestamp (message/contact/
      // assignee). Was epoch-seconds — the one field that didn't match.
      created_at: conn.createdAt.getTime(),
      // Who this account IS, so a receiver can route on the number rather than
      // on an opaque cuid. See WireChannelBase.
      account_label: conn.label,
      account_address:
        (conn.config as { displayPhoneNumber?: string } | null)?.displayPhoneNumber ?? null,
      account_external_id: conn.externalAccountId || null,
      // Whether this account was resolved FROM the event or merely defaulted to.
      // Only the `accountId` branch above reads the account the event actually
      // happened on; the other two are "the workspace's default / first active
      // connection for the medium", which on a multi-account workspace may well
      // be a different number. Reporting a guess as if it were the answer is
      // the bug this whole resolver exists to prevent — so we ship the guess
      // AND say it is one.
      account_is_default_fallback: !accountId,
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
/**
 * WHICH account (ChannelConnection) the event belongs to, from data already on
 * the payload — no DB read, same discipline as `deriveEventChannel`.
 *
 * Without this, `resolveChannel` fell back to the channel's DEFAULT connection,
 * so on a workspace with three WhatsApp numbers EVERY webhook reported the
 * default number's id as `channel.id` — the field the wire contract documents
 * as "the ChannelConnection cuid". A partner routing on it was told the wrong
 * number for every conversation, and the per-(workspace, channel) cache made it
 * consistently wrong rather than occasionally.
 */
function deriveEventAccountId(event: Record<string, unknown>): string | null {
  // Only the conversation snapshot carries it today (message.received and the
  // conversation.* events). No event sets it at the top level, so there is no
  // branch for that: an unused one would be untested forward-compat, and the
  // `conversationId` fallback in `resolveEventAccountId` already covers every
  // conversation-scoped event correctly — a future top-level field would be an
  // optimisation to add HERE, not a correctness gap.
  const conversation = event.conversation as
    | { channelConnectionId?: string | null }
    | undefined;
  return conversation?.channelConnectionId ?? null;
}

function deriveEventChannel(event: Record<string, unknown>): ChannelMedium | null {
  // Top-level `channel` — carried by message.status_changed (which has no
  // `message`/`conversation` snapshot to read it from), so a delivery/read
  // receipt attributes to the right channel instead of the primary-connection
  // fallback.
  const topLevel = event.channel as ChannelMedium | undefined;
  if (topLevel) return topLevel;
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
