import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";

import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";
import { publishInTx } from "@/lib/events/outbox";
import type { DomainEventOf } from "@ccp/shared/events/types";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import { transcodeToOggOpus } from "@/lib/media/audio-transcode";
import {
  consumeConversationSendBudget,
  ConversationSendRateLimitedError,
} from "@/lib/messaging/conversation-send-budget";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { SendTextValidationError } from "@/lib/messaging/send-text-internal";
import { sendInteractiveInternal } from "@/lib/messaging/send-interactive-internal";
import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { ProviderName } from "@ccp/shared/types";
import { loadReplySnapshotById, mediaPreview } from "@/lib/providers/ingest";
import { MetaSendError, normalizeMetaSendError } from "@/lib/providers/meta";
import { getConversationWithRefs } from "@/lib/queries";
import type {
  ConversationWithRefs,
  ForwardResult,
  MediaAttachment,
  MediaKind,
  Message,
} from "@ccp/shared/types";
import { computeWindowStatus } from "@ccp/shared/utils/window";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type {
  ForwardMessagesInput,
  SendMediaFormInput,
  SendTemplateInput,
  SendTextInput,
} from "./messages.schemas";
import { runWithSendIdempotency } from "./send-idempotency";
import { enqueueMessageSend } from "./send-queue";

/**
 * Meta's accepted audio MIME types for `/messages` sends. Anything outside
 * this set comes back as a vague `provider_rejected`. Voice notes (the
 * waveform-rendering kind) additionally REQUIRE `audio/ogg` with opus —
 * setting `voice: true` on an audio/mp4 send is itself a Meta-side reject.
 */
const META_AUDIO_ALLOWED = new Set([
  "audio/aac",
  "audio/mp4",
  "audio/mpeg",
  "audio/amr",
  "audio/ogg",
]);

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Commit the side-effects that follow a successful outbound DB write:
   * bump the conversation summary AND persist the `message.sent` event
   * to the outbox — both in a single transaction. The outbox drainer
   * picks up the event after commit and dispatches subscribers.
   *
   * Replaces the previous `void this.bus.publish(...)` + `void this.db
   * .conversation.updateMany(...)` shape, which had two latent gaps:
   *   (a) process death between the Message create and bus.publish lost
   *       the realtime emit forever (`message.sent` is the inbox-shell's
   *       only signal for outbound persistence),
   *   (b) the synchronous bus.publish wrote its outbox row AFTER running
   *       subscribers — a crash mid-dispatch dropped the audit row too.
   *
   * publishInTx is the same primitive the inbound ingest path uses.
   *
   * The previous shape used a CAS `lastMessageAt: { lte: bumpTimestamp }`,
   * which silently no-op'd the UPDATE whenever an interleaved write
   * (inbound webhook, workflow auto-reply via the bare-UPDATE path in
   * lib/messaging/send-*-internal.ts, or a parallel send) had raced past
   * the worker's stale-from-preflight `bumpTimestamp`. The conversation
   * row stayed pinned to the racing write's preview, while THIS send's
   * `message.sent` event still fanned out with the now-stale outbound
   * preview — so the agent's list briefly flashed the correct value via
   * socket, then snapped back to the stuck preview on the next refresh.
   * Read `lastMessageAt` inside the tx and compute an effective bump that
   * is strictly monotonic relative to current DB state; that keeps the
   * inbox sort order correct AND guarantees the latest outbound's preview
   * actually lands.
   */
  private async commitOutboundEvent(args: {
    conversationId: string;
    bumpTimestamp: Date;
    preview: string;
    /**
     * `unreadCount` is omitted from the caller — outbound doesn't change
     * the team-wide counter, so the current row value is the authoritative
     * absolute we publish. Reading it inside the tx keeps the event in sync
     * with whatever inbound increments interleaved (and serializable
     * isolation ensures the read is consistent with the write below).
     */
    event: Omit<DomainEventOf<"message.sent">, "unreadCount" | "lastMessageAt">;
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const current = await tx.conversation.findUnique({
        where: { id: args.conversationId },
        select: { lastMessageAt: true, unreadCount: true },
      });
      if (!current) return;
      const effectiveBump =
        current.lastMessageAt >= args.bumpTimestamp
          ? new Date(current.lastMessageAt.getTime() + 1)
          : args.bumpTimestamp;
      await tx.conversation.update({
        where: { id: args.conversationId },
        data: {
          lastMessageAt: effectiveBump,
          lastMessagePreview: args.preview,
        },
      });
      await publishInTx(tx, {
        ...args.event,
        lastMessageAt: effectiveBump.toISOString(),
        unreadCount: current.unreadCount,
      });
    });
  }

  /**
   * Free-form text send — public HTTP entry point.
   *
   * Two-phase contract introduced in S1 (audit follow-up):
   *
   *   1. Synchronous preflight — light parallel reads to surface 4xx-class
   *      errors inline (conversation not found, contact missing phone,
   *      24-hour window closed, reply target gone, WhatsApp not connected).
   *      The agent sees these in the same response shape as before.
   *
   *   2. Enqueue + return — the actual Meta send (~200-800ms) runs in the
   *      background `message-sends` worker. The HTTP response returns in
   *      ~5ms with `{ ok: true, clientTempId }`. The originating client's
   *      optimistic bubble already paints by clientTempId; the worker's
   *      `message.sent` publish reconciles it. On failure, the worker
   *      publishes `message.send_failed` which fans out as `message:failed`
   *      so the optimistic row flips to error state — mirrors the
   *      pre-queue inline-throw UX.
   *
   * `runWithSendIdempotency` still dedupes double-click / network-retry
   * before the enqueue; BullMQ's jobId on clientTempId is a second layer.
   */
  async sendText(
    teamId: string,
    userId: string,
    input: SendTextInput,
  ): Promise<{ ok: true; clientTempId?: string }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: input.conversationId,
        clientTempId: input.clientTempId,
      },
      async () => {
        const pre = await this.preflightTextSend(teamId, input);
        await enqueueMessageSend({
          kind: "text",
          teamId,
          userId,
          conversationId: input.conversationId,
          provider: pre.provider,
          phoneNumber: pre.phoneNumber,
          body: input.body,
          replyToMessageId: pre.replyToMessageId,
          replyToExternalId: pre.replyToExternalId,
          clientTempId: input.clientTempId,
          receivedAt: new Date().toISOString(),
        });
        return {
          ok: true as const,
          ...(input.clientTempId ? { clientTempId: input.clientTempId } : {}),
        };
      },
    );
  }

  /**
   * Synchronous preflight for sendText. Surfaces deterministic 4xx errors
   * so the agent doesn't see the optimistic bubble paint then collapse to
   * failed 500ms later for cases we can detect up front (window closed,
   * missing phone, reply-target gone, WhatsApp unconfigured).
   *
   * Returns the resolved values the worker needs (phone number + reply
   * target ids) so the worker can skip the DB round-trip entirely —
   * everything we read here is threaded through the BullMQ payload. The
   * worker still verifies conversation existence (catches a deletion in
   * the queue gap) and re-loads Meta config (process-cached after the
   * first call, so steady-state cost is a Map lookup, not a query).
   */
  private async preflightTextSend(
    teamId: string,
    input: SendTextInput,
  ): Promise<{
    provider: ProviderName;
    phoneNumber: string;
    replyToMessageId: string | null;
    replyToExternalId?: string;
  }> {
    const { conversationId, replyToMessageId: replyToMessageIdRaw } = input;
    const [conversation, replyToRow] = await Promise.all([
      this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: {
          id: true,
          // Channel is conversation-owned — the preflight returns this provider
          // (resolveContactChannel below only supplies the destination address).
          provider: true,
          contact: {
            select: {
              phoneNumber: true,
              identityProvider: true,
              externalContactId: true,
              lastInboundAt: true,
            },
          },
        },
      }),
      replyToMessageIdRaw
        ? this.db.message.findFirst({
            where: { id: replyToMessageIdRaw, conversationId, teamId },
            select: { id: true, externalId: true },
          })
        : Promise.resolve(null),
    ]);
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // Resolve the destination ADDRESS from the contact identity. The PROVIDER
    // is conversation-owned (the row is the source of truth for which channel
    // this thread sends on); equal to the contact's by construction today.
    let channel;
    try {
      channel = resolveContactChannel(conversation.contact);
    } catch (err) {
      if (err instanceof NoChannelDestinationError) {
        throw new BadRequestException({
          error: "contact_has_no_phone",
          detail: "This contact has no reachable address.",
        });
      }
      throw err;
    }
    const provider = conversation.provider;
    const binding = getProviderBinding(provider);

    // Fail fast on a not-connected provider so the 4xx surfaces in the POST
    // response instead of as a queued job that fails in the worker. (The
    // config can't be prefetched in parallel with the conversation lookup
    // anymore — we need the contact's channel first — but a cached config is
    // a Map read, so the serialization cost is sub-millisecond steady-state.)
    try {
      await binding.getSendConfig(teamId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp_not_connected",
          detail: err.message,
        });
      }
      throw err;
    }

    // Free-form send window — driven by the provider capability; `null` skips.
    const windowMs = binding.provider.capabilities.freeFormWindowMs;
    if (windowMs !== null) {
      const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail: "24-hour window closed — send an approved template to re-engage this contact.",
          lastInboundAt,
        });
      }
    }
    // Resolve the reply target FIRST. A flood of replies pointing at a
    // deleted message id would otherwise drain the per-conversation send
    // budget (30/min) without producing any DB writes or Meta calls —
    // legitimate replies then get false-positive rate-limited.
    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (replyToMessageIdRaw) {
      if (!replyToRow) {
        throw new BadRequestException({
          error: "reply_target_not_found",
          detail: "The message you're replying to no longer exists in this conversation.",
        });
      }
      replyToMessageId = replyToRow.id;
      if (!replyToRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyToRow.externalId;
      }
    }
    // Per-conversation send ceiling. Cheap second-axis bound that catches a
    // partner-driven hot-potato (their automation reacts to its own
    // `message.sent` webhook) inside one thread before the per-key 60/min
    // budget bites — a runaway loop now burns 30 sends/min/thread, not
    // 60/min/key. Throws ConversationSendRateLimitedError on hit; the
    // handler at the controller layer maps it to 429 + Retry-After.
    try {
      consumeConversationSendBudget(teamId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        throw new HttpException(
          {
            error: "conversation_rate_limited",
            detail: err.message,
            retryAfter: err.retryAfter,
          },
          429,
        );
      }
      throw err;
    }
    return {
      provider,
      phoneNumber: channel.to,
      replyToMessageId,
      ...(replyToExternalId ? { replyToExternalId } : {}),
    };
  }

  /**
   * Worker-side executor. The HTTP preflight already verified the
   * conversation, the contact's phone, the 24h window, and the reply
   * target — the values needed at send time are all in the queue payload.
   * The worker's job is therefore narrow:
   *
   *   1. Verify the conversation still exists (catches a deletion between
   *      enqueue and pickup; without this the FK error would fire AFTER
   *      the Meta send and leave a "sent-to-customer-but-no-local-row"
   *      ghost).
   *   2. Resolve Meta credentials (process-cached, ~Map lookup in steady
   *      state — first call per team is one DB hit).
   *   3. Load the reply snapshot (cosmetic — the quote pill payload).
   *   4. Call Meta.
   *   5. Idempotent DB write + bus publish.
   *
   * The 24h-window re-check is gone: if the contact's window closes in
   * the queue gap (sub-second normally, an edge case at exactly
   * 23:59:59 → 00:00:00) Meta itself rejects with `outside_24h_window`,
   * which `normalizeMetaSendError` maps to a non-recoverable failure
   * that `categorizeSendError` flips into a `message.send_failed` event.
   * Same UX as the inline preflight, one less DB round-trip per send.
   *
   * `receivedAt` is stamped at HTTP arrival, not pickup, so the row's
   * `timestamp` and the conversation reorder match send order even when
   * the worker has a brief backlog.
   */
  async executeTextSendJob(
    data: import("./send-queue").SendTextJobData,
    jobId?: string,
  ): Promise<void> {
    const {
      teamId,
      userId,
      conversationId,
      body,
      clientTempId,
      phoneNumber,
      replyToMessageId,
      replyToExternalId,
    } = data;
    const receivedAt = new Date(data.receivedAt);
    // `provider` may be absent on jobs enqueued before the field existed —
    // default to Meta. The binding gives us provider + config loader.
    const provider: ProviderName = data.provider ?? "meta_cloud";
    const binding = getProviderBinding(provider);

    // Cheap indexed existence check (no contact join, no select-all).
    // Conversation row gone → fail non-recoverable BEFORE we hit Meta so
    // we don't strand a customer with a message no agent can see.
    // Pull lastMessageAt for the timestamp-monotonicity guard further down.
    const [exists, configOrErr] = await Promise.all([
      this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: { id: true, lastMessageAt: true, contactId: true },
      }),
      binding.getSendConfig(teamId).catch((err: unknown) => {
        if (err instanceof ProviderNotConfiguredError) return err;
        throw err;
      }),
    ]);
    if (!exists) throw new NotFoundException({ error: "conversation not found" });
    if (configOrErr instanceof ProviderNotConfiguredError) {
      throw new ConflictException({
        error: "whatsapp_not_connected",
        detail: configOrErr.message,
      });
    }
    const config = configOrErr;

    // Reply snapshot loads in parallel with the Meta send — pure cosmetic
    // payload for the quote pill; failure here degrades to a quoteless
    // bubble, never blocks the send.
    const replySnapshotPromise = replyToMessageId
      ? loadReplySnapshotById(replyToMessageId)
      : Promise.resolve(null);

    // BEFORE-Meta-call idempotency: try to insert an OutboundSendAttempt
    // row keyed by jobId. The first attempt succeeds and proceeds to call
    // Meta. A retry job (same jobId, after worker death) will P2002 on
    // this insert; we then inspect the existing row to decide what to do.
    //
    // If jobId is undefined (server-driven send with no clientTempId, no
    // BullMQ jobId — none today, but defensive) we skip the attempt log
    // entirely. The downstream DB unique constraint on externalId still
    // dedupes; we just don't get the "refuse to retry" protection.
    let attemptCreated = false;
    if (jobId) {
      try {
        await this.db.outboundSendAttempt.create({
          data: { jobId, teamId, conversationId },
        });
        attemptCreated = true;
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          // Prior attempt exists. Two sub-cases:
          const prior = await this.db.outboundSendAttempt.findUnique({
            where: { jobId },
          });
          if (prior?.completedAt && prior.externalId) {
            // (a) Prior attempt succeeded — Meta already sent the message
            // and we have the wamid. Look up the Message row written by
            // the prior attempt and re-publish message.sent so the
            // originating client gets the bubble swap. Idempotent at the
            // socket layer (frontend reducer dedups by externalId).
            const existing = await this.db.message.findFirst({
              where: {
                teamId,
                provider,
                externalId: prior.externalId,
              },
            });
            if (existing) {
              const replySnapshot = await replySnapshotPromise;
              const replayed: Message = {
                id: existing.id,
                teamId: existing.teamId,
                conversationId: existing.conversationId,
                externalId: existing.externalId ?? prior.externalId,
                senderUserId: existing.senderUserId,
                body: existing.body,
                direction: existing.direction,
                provider: existing.provider,
                status: existing.status,
                rawPayload: existing.rawPayload as Record<string, unknown>,
                timestamp: existing.timestamp.toISOString(),
                ...(existing.replyToMessageId
                  ? {
                      replyToMessageId: existing.replyToMessageId,
                      replyTo: replySnapshot ?? null,
                    }
                  : {}),
              };
              // publish() (not publishInTx) — this is a recovery re-emit
              // for a client whose first delivery may have been lost. The
              // audit row may dupe (rare; only when the original publish
              // had also fired); accepted because the alternative is the
              // client UI never showing the bubble.
              await publish({
                type: "message.sent",
                teamId,
                conversationId: existing.conversationId,
                contactId: exists.contactId,
                message: replayed,
                preview: existing.body.slice(0, 200),
                senderUserId: userId,
                ...(clientTempId ? { clientTempId } : {}),
              } as DomainEventOf<"message.sent">);
              return;
            }
            // No Message row despite a completed attempt — extremely rare
            // (would require a process death after the attempt completed
            // but before the message commit). Fall through to the
            // refuse-to-retry path; user can re-send with a new
            // clientTempId.
          }
          // (b) Prior attempt incomplete (no completedAt, or completed
          // but Message row not findable) — Meta MAY have already sent
          // the message. Refusing to retry avoids the rare double-charge.
          // Non-recoverable so BullMQ stops retrying; the worker
          // categorizes this `error` field as non-recoverable, publishes
          // message.send_failed, and the client's failed-bubble UI lets
          // the user retry with a new clientTempId.
          throw new UnprocessableEntityException({
            error: "send_in_progress_or_lost",
            message:
              "A previous attempt for this message may have already reached WhatsApp. Refusing to retry to avoid a duplicate send. Re-send to try again.",
            status: 409,
          });
        }
        throw err;
      }
    }

    let send;
    try {
      send = await binding.provider.sendText(
        {
          to: phoneNumber,
          body,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
      // Stamp the attempt as failed so any retry sees `failedAt` set and
      // proceeds normally (failed attempts are bookkeeping; BullMQ already
      // decided whether to retry via categorizeSendError).
      if (attemptCreated && jobId) {
        await this.db.outboundSendAttempt
          .update({
            where: { jobId },
            data: {
              failedAt: new Date(),
              failureReason: (err instanceof Error
                ? err.message
                : String(err)
              ).slice(0, 500),
            },
          })
          .catch(() => undefined);
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      this.logger.error("sendText failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Meta succeeded — mark the attempt completed BEFORE writing the
    // Message row. Order matters: if we crash between Meta returning and
    // the Message insert, a retry would see `completedAt` set + no
    // Message row, fall through to the refuse-to-retry path, and the
    // user re-sends with a new clientTempId. The Meta-sent message
    // remains uncatalogued in our inbox — rare, manually recoverable.
    // (Alternative: write Message first, then stamp attempt completed.
    // But the symmetric race exists: crash between Meta and Message,
    // retry would proceed and double-send.)
    if (attemptCreated && jobId) {
      await this.db.outboundSendAttempt
        .update({
          where: { jobId },
          data: {
            completedAt: new Date(),
            externalId: send.externalId,
          },
        })
        .catch((err) => {
          this.logger.warn(
            `OutboundSendAttempt completed-stamp failed for jobId=${jobId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
    }

    // Timestamp monotonicity guard — outbound must sort strictly after any
    // inbound it might be responding to. Meta's webhook timestamps are
    // second-precision (rounded), so an outbound landing in the same
    // second can otherwise sort BEFORE the inbound. See
    // send-text-internal.ts for the full rationale.
    const messageTimestamp =
      exists.lastMessageAt && exists.lastMessageAt >= receivedAt
        ? new Date(exists.lastMessageAt.getTime() + 1)
        : receivedAt;
    const [created, replySnapshot] = await Promise.all([
      createOutboundMessageIdempotent({
        teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: userId,
        body,
        direction: "out",
        provider,
        status: "sent",
        rawPayload: { sentVia: "api/messages" } as Prisma.InputJsonValue,
        timestamp: messageTimestamp,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      }),
      replySnapshotPromise,
    ]);

    const preview = body.slice(0, 200);
    const message: Message = {
      id: created.id,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body,
      direction: "out",
      provider,
      status: "sent",
      rawPayload: { sentVia: "api/messages" },
      timestamp: messageTimestamp.toISOString(),
      ...(replyToMessageId
        ? { replyToMessageId, replyTo: replySnapshot ?? null }
        : {}),
    };

    // Conversation bump + `message.sent` outbox row commit atomically.
    // Drainer picks up the row ~100ms after commit and dispatches every
    // subscriber. Trades a few ms of HTTP latency for durable realtime —
    // a crash here loses neither the bump nor the event.
    try {
      await this.commitOutboundEvent({
        conversationId,
        bumpTimestamp: messageTimestamp,
        preview,
        event: {
          type: "message.sent",
          teamId,
          conversationId,
          contactId: exists.contactId,
          message,
          preview,
          senderUserId: userId,
          ...(clientTempId ? { clientTempId } : {}),
        },
      });
    } catch (err) {
      // Message row is durable; only the bump + outbox row failed. Log
      // and continue — the next inbound or cold load will reconcile the
      // conversation summary, and the operator can spot the gap by
      // grepping for this exact log line.
      this.logger.error(
        `sendText commit failed for message=${created.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Outbound media send. Same shape as /api/messages/media POST:
   *
   *   A. Pre-flight: conversation, 24h window, replyTo, send config.
   *   B. PARALLEL: Meta /media upload AND blob-storage upload (both pure
   *      functions of bytes; critical path was sum, now is max).
   *   C. Meta /messages send referencing the uploaded mediaId.
   *   D. Post-send (cannot throw back to agent — a 5xx would prompt a retry
   *      that double-sends to the customer on WhatsApp):
   *      i.   Resolve blob upload — degrade to text-only on blob failure.
   *      ii.  Idempotent DB insert; degrade response if DB hiccups.
   *      iii. Publish `message.sent` and fire-and-forget the conversation
   *           summary bump.
   *
   * Returns `{ messageId, warning? }`. A non-null `warning` means the message
   * landed on WhatsApp but local persistence partially failed — surface to the
   * agent so they know NOT to retry (which would double-send).
   */
  async sendMedia(
    teamId: string,
    userId: string,
    form: SendMediaFormInput,
    file: Express.Multer.File,
  ): Promise<{ messageId: string | null; warning?: string }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: form.conversationId,
        clientTempId: form.clientTempId,
      },
      () => this.sendMediaInner(teamId, userId, form, file),
    );
  }

  private async sendMediaInner(
    teamId: string,
    userId: string,
    form: SendMediaFormInput,
    file: Express.Multer.File,
  ): Promise<{ messageId: string | null; warning?: string }> {
    try {
      return await this.sendMediaWithTempFile(teamId, userId, form, file);
    } finally {
      // Disk-backed multer wrote the multipart payload to file.path. Whether
      // the send succeeded, threw mid-flight, or the agent disconnected,
      // unlink the temp file so we don't accumulate orphan blobs in /tmp
      // (a steady 100 MB/upload leak over a shift on a small VPS).
      // Best-effort: ENOENT (already-removed) and EACCES are non-fatal here.
      if (file.path) {
        unlink(file.path).catch((err) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.warn(
              `tempfile cleanup failed for ${file.path}: ${err instanceof Error ? err.message : err}`,
            );
          }
        });
      }
    }
  }

  private async sendMediaWithTempFile(
    teamId: string,
    userId: string,
    form: SendMediaFormInput,
    file: Express.Multer.File,
  ): Promise<{ messageId: string | null; warning?: string }> {
    const receivedAt = new Date();
    const { conversationId, caption, clientTempId, replyToMessageId: replyToMessageIdRaw } = form;

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        contactId: true,
        // Channel is conversation-owned — bind + stamp the send from here.
        provider: true,
        // For the timestamp monotonicity guard further down — outbound
        // must sort strictly after any inbound it might be responding to.
        lastMessageAt: true,
        contact: {
          select: {
            phoneNumber: true,
            identityProvider: true,
            externalContactId: true,
            name: true,
            lastInboundAt: true,
          },
        },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    let channel;
    try {
      channel = resolveContactChannel(conversation.contact);
    } catch (err) {
      if (err instanceof NoChannelDestinationError) {
        throw new BadRequestException({
          error: "contact_has_no_phone",
          detail: "This contact has no reachable address.",
        });
      }
      throw err;
    }
    const provider = conversation.provider;
    const binding = getProviderBinding(provider);

    // Free-form send window — media (like free-form text) is template-only
    // outside it. Driven by the provider capability; `null` skips the check.
    const windowMs = binding.provider.capabilities.freeFormWindowMs;
    if (windowMs !== null) {
      const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail:
            "24-hour window closed — media can't be sent freely. Use an approved template to re-engage.",
          lastInboundAt,
        });
      }
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (replyToMessageIdRaw) {
      const replyToRow = await this.db.message.findFirst({
        where: { id: replyToMessageIdRaw, conversationId, teamId },
        select: { id: true, externalId: true },
      });
      if (replyToRow) {
        replyToMessageId = replyToRow.id;
        // Don't forward a placeholder externalId to Meta (would 400 it). The
        // reply snapshot still resolves locally; we just don't quote on the
        // wire when the parent is still pending-send.
        if (!replyToRow.externalId.startsWith("tmp_")) {
          replyToExternalId = replyToRow.externalId;
        }
      }
    }

    // Strip codec parameters (`audio/ogg;codecs=opus` → `audio/ogg`). Meta's
    // `/media` upload reads the `type` form field strictly; the codec suffix
    // that Chrome's MediaRecorder emits is enough to make it reject the
    // payload with a non-obvious error. Blob storage was already tolerant
    // (splits on `;` for its allowlist check) — Meta isn't.
    const rawMime = file.mimetype || "application/octet-stream";
    // `let` so the voice-note transcode below can rewrite it to audio/ogg.
    let mimeType =
      rawMime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
    const kind = kindFromMime(mimeType);
    const cap = MEDIA_SIZE_CAPS[kind];
    if (file.size > cap) {
      throw new PayloadTooLargeException({
        error: `file too large for ${kind}: ${file.size} bytes > ${cap}`,
        cap,
      });
    }
    // Stickers: Meta only accepts `image/webp`. Reject other types up front
    // with a clear error instead of letting Meta reject with opaque code 100.
    if (kind === "sticker" && mimeType.toLowerCase() !== "image/webp") {
      throw new BadRequestException({
        error: "invalid_sticker_mime",
        detail: `WhatsApp stickers must be image/webp (got ${mimeType}).`,
      });
    }
    // Audio: Meta only accepts a specific mime set. `audio/webm` in particular
    // is a frequent silent failure — Chrome's MediaRecorder defaults to it for
    // voice notes, uploads succeed, then Meta returns a confusing
    // `provider_rejected` at send time. Block it here with a clear error.
    // The blob-storage allowlist still permits webm (so we can debug-replay),
    // but we won't push it to Meta.
    if (kind === "audio" && !META_AUDIO_ALLOWED.has(mimeType)) {
      throw new BadRequestException({
        error: "invalid_audio_mime",
        detail:
          `WhatsApp doesn't accept ${mimeType || "this audio format"}. ` +
          "Supported: AAC, MP4 (m4a), MP3, AMR, OGG/Opus. " +
          "If this came from a voice recorder, try a different browser (Chrome 105+, Firefox, Safari).",
      });
    }

    // Read the disk-backed multer temp file ONCE into a single Buffer that
    // both Meta upload + blob-storage upload share. file.buffer is empty
    // under diskStorage; file.path is the temp location set by the
    // controller's diskStorage config. The previous memoryStorage code
    // path pinned ~3x file size in V8 heap during the parallel uploads
    // (multer buffer + Meta Blob copy + blob-storage Blob copy); reading
    // once here + reusing the buffer drops peak to ~1x while the two
    // providers run, since both internal Blobs copy from the same source
    // synchronously per provider but the source itself is shared.
    let bytes = new Uint8Array(await readFile(file.path));
    // `let` so the transcode below can rename the extension to match the new
    // container — Meta keys media type partly off the filename extension, and a
    // `.m4a` name on transcoded ogg bytes makes it reject as octet-stream.
    let filename = file.originalname || "upload";

    // Voice notes must be ogg/opus to DELIVER on WhatsApp. Firefox records that
    // natively; Chrome/Safari can only record audio/mp4, which Meta accepts then
    // fails to DELIVER. Transcode genuine recordings (`form.voice` is the FE's
    // "this is a recording" marker) that aren't already ogg → ogg/opus so they
    // deliver on every browser. We send them as a regular audio clip (NOT a
    // voice note — see the sendMedia call below for why). Uploaded audio FILES
    // (form.voice=false — a user picked an mp3/m4a) are left alone: they deliver
    // fine already. Best-effort: if ffmpeg is missing/fails we log + send original.
    const isRecording = kind === "audio" && form.voice === true;
    if (isRecording && mimeType !== "audio/ogg") {
      try {
        bytes = await transcodeToOggOpus(bytes);
        mimeType = "audio/ogg";
        // Rename the extension to match the new container. Without this the
        // file keeps its recorder extension (e.g. Chrome's `.m4a`) on ogg
        // bytes, and Meta rejects it as application/octet-stream (#131053).
        filename = filename.replace(/\.[^./\\]+$/, "") + ".ogg";
      } catch (err) {
        this.logger.warn(
          `voice transcode to ogg/opus failed; sending original ${mimeType}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const toPhone = channel.to;
    const toName = conversation.contact.name;

    let sendConfig;
    try {
      sendConfig = await binding.getSendConfig(teamId);
    } catch (err) {
      throw new ConflictException({
        error: "WhatsApp is not connected for this team",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // Optional methods — a channel without media support raises a typed error.
    const uploadMedia = requireProviderMethod(binding.provider, "uploadMedia", provider);
    const sendMedia = requireProviderMethod(binding.provider, "sendMedia", provider);

    // Parallel: Meta /media upload AND blob-storage upload. Both pure
    // functions of `bytes`. The team lookup that the blob context needs
    // also kicks off concurrently so it doesn't serialize the upload.
    const blobLabelId = clientTempId ?? randomUUID();
    const teamRowPromise = this.db.team
      .findUnique({ where: { id: teamId }, select: { name: true } })
      .catch(() => null);

    const blobUploadPromise = (async () => {
      const teamRow = await teamRowPromise;
      return blobStorage.upload({
        bytes,
        mimeType,
        kind,
        context: {
          teamId,
          teamSlug: teamRow?.name,
          direction: "out",
          contactPhone: toPhone,
          contactName: toName,
          conversationId,
          // No wamid yet — Meta hasn't returned one. Use client temp id (or
          // a generated uuid) so the dashboard filename is still unique and
          // traceable. Not used for retrieval — purely metadata.
          externalId: blobLabelId,
          originalFilename: filename,
        },
      });
    })();

    // 1) Upload to Meta. Pre-send: throwing is safe — nothing went out yet.
    let mediaId: string;
    try {
      const uploaded = await uploadMedia(
        { bytes, mimeType, filename },
        sendConfig,
      );
      mediaId = uploaded.mediaId;
    } catch (err) {
      // Don't let the parallel blob upload leak as an unhandledRejection on
      // the early-return path.
      blobUploadPromise.catch(() => {});
      // Audio is the format-fragile path (MediaRecorder containers, codec
      // params, voice-note encoding rules). Log the raw Meta error verbatim
      // so a failed voice note is diagnosable from journald instead of the
      // generic normalized code the agent sees.
      if (kind === "audio") {
        this.logger.error(
          `audio uploadMedia failed: mime=${mimeType} size=${file.size} voice=${form.voice} :: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      throw err;
    }

    // 2) Send the message referencing that mediaId. Same logic — throwing
    //    pre-send is fine.
    let send;
    try {
      send = await sendMedia(
        {
          to: toPhone,
          kind,
          mediaId,
          caption: caption || undefined,
          filename: kind === "document" ? filename : undefined,
          ...(replyToExternalId ? { replyToExternalId } : {}),
          // Recordings are sent as a normal audio clip — we don't set
          // `voice: true`. The transcode above (mp4 → clean ogg/opus) is what
          // makes them deliver on every browser. `voice: true` (waveform
          // voice-note rendering) is left off for now; it can be revisited on
          // top of the clean ogg if the waveform UI is wanted.
        },
        sendConfig,
      );
    } catch (err) {
      blobUploadPromise.catch(() => {});
      if (kind === "audio") {
        this.logger.error(
          `audio sendMedia failed: mime=${mimeType} mediaId=${mediaId} voice=${form.voice} :: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      throw err;
    }

    // ── Post-send: Meta has accepted. From here NOTHING is allowed to throw
    // back to the agent. A 5xx would trigger a UI retry → second Meta send →
    // duplicate on the customer's WhatsApp. Degrade silently instead.

    let saved: { key: string; url: string; sizeBytes: number } | null = null;
    try {
      saved = await blobUploadPromise;
    } catch (err) {
      this.logger.error(
        `blob upload failed AFTER successful Meta send (wamid=${send.externalId}); persisting row without local media to avoid duplicate retry`,
        err,
      );
    }

    const previewBody = (caption || mediaPreview(kind)).slice(0, 200);

    // Timestamp monotonicity guard — see send-text-internal.ts for full
    // rationale. Outbound must sort strictly after any inbound in the
    // same second.
    const messageTimestamp =
      conversation.lastMessageAt && conversation.lastMessageAt >= receivedAt
        ? new Date(conversation.lastMessageAt.getTime() + 1)
        : receivedAt;

    const created = await createOutboundMessageIdempotent({
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body: caption,
      direction: "out",
      provider,
      status: "sent",
      rawPayload: {
        sentVia: "api/messages/media",
        mediaId,
        ...(saved ? {} : { blobUploadFailed: true }),
      } as Prisma.InputJsonValue,
      timestamp: messageTimestamp,
      // Persist media columns only when the blob upload succeeded. The
      // mapMessage path (lib/queries/_shared.ts) treats `mediaKind &&
      // !mediaUrl` as "still downloading" — writing them unconditionally
      // when blob failed would leave a stuck "Downloading photo…" spinner
      // forever (outbound has no background-download path to clear it).
      ...(saved
        ? {
            mediaKind: kind,
            mediaMimeType: mimeType,
            mediaCaption: caption || null,
            mediaFilename: kind === "document" ? filename : null,
            mediaKey: saved.key,
            mediaUrl: saved.url,
            mediaSizeBytes: saved.sizeBytes,
          }
        : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    }).catch((err): null => {
      this.logger.error(
        `DB persist failed AFTER successful Meta send (wamid=${send.externalId})`,
        err,
      );
      return null;
    });

    if (!created) {
      // Still 200 — the message went out; agent must NOT retry.
      return {
        messageId: null,
        warning: "message sent but local persistence failed",
      };
    }
    const createdId = created.id;

    const media: MediaAttachment | undefined = saved
      ? {
          kind,
          url: `/api/media/${createdId}`,
          mimeType,
          sizeBytes: saved.sizeBytes,
          ...(caption ? { caption } : {}),
          ...(kind === "document" ? { filename } : {}),
        }
      : undefined;

    const replySnapshot = replyToMessageId
      ? await loadReplySnapshotById(replyToMessageId).catch(() => null)
      : null;

    const message: Message = {
      id: createdId,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body: caption,
      direction: "out",
      provider,
      status: "sent",
      rawPayload: {
        sentVia: "api/messages/media",
        mediaId,
        ...(saved ? {} : { blobUploadFailed: true }),
      },
      timestamp: messageTimestamp.toISOString(),
      ...(media ? { media } : {}),
      ...(replyToMessageId
        ? { replyToMessageId, replyTo: replySnapshot ?? null }
        : {}),
    };

    // Conversation bump + `message.sent` outbox row commit atomically.
    // Drainer dispatches subscribers after commit, closing the
    // "Meta-accepted but realtime-lost on crash" gap. Media sends count
    // as outbound messages for analytics, so they route through the
    // same path as text.
    try {
      await this.commitOutboundEvent({
        conversationId,
        bumpTimestamp: messageTimestamp,
        preview: previewBody,
        event: {
          type: "message.sent",
          teamId,
          conversationId,
          contactId: conversation.contactId,
          message,
          preview: previewBody,
          senderUserId: userId,
          ...(clientTempId ? { clientTempId } : {}),
        },
      });
    } catch (err) {
      this.logger.error(
        `sendMedia commit failed for message=${createdId}: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      messageId: createdId,
      ...(saved
        ? {}
        : { warning: "message sent but media file could not be archived locally" }),
    };
  }

  /**
   * Forward N existing messages to M contacts. Sequential — each Meta send
   * is ~300ms; bounded by the schema at messages*contacts ≤ 40 to stay
   * under the reverse-proxy idle timeout. Past that, agents use broadcasts.
   *
   * Per contact:
   *   1. Skip non-phone contacts (Instagram/Telegram identities) with an
   *      explicit failure.
   *   2. Reuse the contact's single conversation (one-contact-one-thread
   *      invariant); closed threads reopen to `pending` with `silent: true`
   *      on the publish so `conversation_opened` workflows don't trigger
   *      for every forward (audit + analytics DO run — there should be a
   *      "Reopened by forward" timeline row).
   *   3. Replay source messages oldest-first. On a 24h-window-closed (Meta
   *      error 131047), break THIS contact's loop — every later send would
   *      fail the same way.
   *
   * Forwards flow through the analytics subscriber, so each forwarded
   * message counts toward outgoingMessagesCount + stamps firstResponseAt
   * when prior inbound exists — matches text-send semantics.
   *
   * Per-send error scopes:
   *   - PRE-send (Meta upload + Meta send): throw → recipient failed.
   *   - POST-send (blob upload + DB row + emit): NEVER throws back. The
   *     customer already has the message; a 5xx here would lie to the
   *     agent AND tempt a UI retry → duplicate send.
   */
  async forward(
    teamId: string,
    userId: string,
    input: ForwardMessagesInput,
  ): Promise<{ results: ForwardResult[] }> {
    // De-dupe input lists — Zod doesn't strip dupes; preserves prior behavior.
    const messageIds = [...new Set(input.messageIds)];
    const contactIds = [...new Set(input.contactIds)];

    // Source messages, team-scoped, oldest-first so order is preserved at
    // the destination. Drop failed rows (no real wamid / never delivered).
    // `omit: rawPayload` because forward only needs body + media metadata;
    // pulling the full Meta webhook payload (5-20 KB each) for N×M forward
    // wastes a lot of wire bytes.
    const sourceRows = await this.db.message.findMany({
      where: { id: { in: messageIds }, teamId, status: { not: "failed" } },
      orderBy: { timestamp: "asc" },
      omit: { rawPayload: true },
    });
    if (sourceRows.length === 0) {
      throw new BadRequestException({
        error: "none of those messages can be forwarded",
      });
    }

    // Config + provider are resolved PER target contact below — each contact
    // can be on its own channel. (Was a single pre-loop Meta fetch + 409 when
    // unconnected; now an unconnected provider surfaces as a per-contact
    // failure in the results, consistent with the existing per-contact
    // "no phone number" failure path.)
    const contacts = await this.db.contact.findMany({
      where: { id: { in: contactIds }, teamId },
      include: { tags: { select: { id: true } } },
    });
    if (contacts.length === 0) {
      throw new NotFoundException({ error: "no such contacts" });
    }

    // Cache source-media bytes across recipients. Stored as a Promise so
    // parallel contact processors coalesce on a single in-flight fetch —
    // without that, forwarding 1 media message to 5 contacts would download
    // the source bytes 5× in parallel. `null` is cached too — a
    // missing/unreadable file shouldn't be retried per-recipient.
    type MediaBytes = {
      bytes: Uint8Array;
      mime: string;
      filename: string | null;
      kind: MediaKind;
    };
    const mediaCache = new Map<string, Promise<MediaBytes | null>>();
    const loadMediaBytes = (
      m: (typeof sourceRows)[number],
    ): Promise<MediaBytes | null> => {
      const existing = mediaCache.get(m.id);
      if (existing) return existing;
      const promise = (async (): Promise<MediaBytes | null> => {
        // Prefer mediaUrl (CDN URL — single hop). Fall back to mediaKey for
        // rows that predate the URL column. Same provider either way.
        const handle = m.mediaUrl ?? m.mediaKey;
        if (!handle || !m.mediaKind) return null;
        try {
          const fetched = await blobStorage.fetch(handle);
          return {
            bytes: fetched.bytes,
            mime: m.mediaMimeType ?? fetched.mimeType,
            filename: m.mediaFilename ?? null,
            kind: m.mediaKind as MediaKind,
          };
        } catch {
          return null;
        }
      })();
      mediaCache.set(m.id, promise);
      return promise;
    };

    const teamRow = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    // Per-contact worker. Each contact is an independent destination (its
    // own conversation row, its own Meta send sequence) so they can run
    // concurrently. Within a contact the message loop stays serial to
    // preserve the original send order at the destination.
    const processContact = async (
      contact: (typeof contacts)[number],
    ): Promise<ForwardResult> => {
      let channel;
      try {
        channel = resolveContactChannel(contact);
      } catch {
        return {
          contactId: contact.id,
          contactName: contact.name,
          ok: false,
          sent: 0,
          failed: sourceRows.length,
          error: "contact has no reachable address",
        };
      }
      const binding = getProviderBinding(channel.provider);
      let sendConfig;
      try {
        sendConfig = await binding.getSendConfig(teamId);
      } catch (err) {
        return {
          contactId: contact.id,
          contactName: contact.name,
          ok: false,
          sent: 0,
          failed: sourceRows.length,
          error:
            err instanceof ProviderNotConfiguredError
              ? "channel not connected"
              : err instanceof Error
                ? err.message
                : "send config error",
        };
      }
      const contactPhone = channel.to;

      // One-contact-one-conversation invariant. Closed → pending (same
      // semantics as webhook ingest + broadcast runner reopen-on-send).
      const existing = await this.db.conversation.findFirst({
        where: { teamId, contactId: contact.id },
        orderBy: { lastMessageAt: "desc" },
      });
      const conversation = !existing
        ? await this.db.conversation.create({
            data: {
              teamId,
              contactId: contact.id,
              // Thread channel = the channel resolved for this send.
              provider: channel.provider,
              status: "pending",
              lastMessagePreview: "",
            },
          })
        : existing.status === "closed"
          ? await this.db.conversation.update({
              where: { id: existing.id },
              data: { status: "pending" },
            })
          : existing;
      // Reopen broadcast — see method docstring for the `silent: true`
      // rationale (workflow chain-trigger avoidance; audit + analytics
      // still fire).
      if (existing?.status === "closed") {
        await this.bus.publish({
          type: "conversation.status_changed",
          teamId,
          conversationId: conversation.id,
          previousStatus: "closed",
          newStatus: "pending",
          changedByUserId: userId,
          contact: workflowContactSnapshot(contact),
          silent: true,
        });
      }
      const conversationIsNew = !existing;
      let emittedForConversation = false;

      // First emit per new conversation carries the full ConversationWithRefs
      // so inbox lists can splice the row in without a refetch. Routes
      // through commitOutboundEvent so the conversation bump + outbox row
      // commit atomically (drainer dispatches after commit). Same shape as
      // sendText / sendMedia — no fire-and-forget gap that loses the
      // realtime emit on a mid-publish crash.
      const emitForwarded = async (
        message: Message,
        preview: string,
        bumpTimestamp: Date,
      ): Promise<void> => {
        let newConversation: ConversationWithRefs | undefined;
        if (conversationIsNew && !emittedForConversation) {
          const refs = await getConversationWithRefs(teamId, conversation.id, {
            messageLimit: 1,
          });
          if (refs) newConversation = refs.data;
        }
        emittedForConversation = true;
        await this.commitOutboundEvent({
          conversationId: conversation.id,
          bumpTimestamp,
          preview,
          event: {
            type: "message.sent",
            teamId,
            conversationId: conversation.id,
            contactId: contact.id,
            message,
            preview,
            senderUserId: userId,
            ...(newConversation ? { newConversation } : {}),
          },
        });
      };

      let sent = 0;
      let failed = 0;
      let firstError: string | undefined;

      for (const src of sourceRows) {
        try {
          if (src.mediaKind) {
            // Required lazily (inside the per-message try) so a channel without
            // media support fails just THIS media message, not the whole
            // forward — text messages in the same batch still go through.
            const uploadMedia = requireProviderMethod(
              binding.provider,
              "uploadMedia",
              channel.provider,
            );
            const sendMedia = requireProviderMethod(
              binding.provider,
              "sendMedia",
              channel.provider,
            );
            const mb = await loadMediaBytes(src);
            if (!mb) {
              failed++;
              firstError ??= "a media file is no longer available";
              continue;
            }
            const caption =
              (src.mediaCaption ?? src.body ?? "").trim() || undefined;
            const filename = mb.filename ?? "upload";
            const withCaption = captionable(mb.kind) ? caption : undefined;

            // Pre-send. Run the Meta media upload and our own blob-storage
            // upload in parallel — both consume `mb.bytes` and neither
            // depends on the other. Saves ~200-500ms per forwarded media
            // message vs. the previous strict serial order.
            //
            // The blob upload's `externalId` context field gets a
            // placeholder (it's only used for diagnostic labelling on
            // UploadThing's side); the canonical link to Meta lives on
            // the Message row via `externalId` after the send completes.
            const [uploaded, saved] = await Promise.all([
              uploadMedia(
                { bytes: mb.bytes, mimeType: mb.mime, filename },
                sendConfig,
              ),
              blobStorage
                .upload({
                  bytes: mb.bytes,
                  mimeType: mb.mime,
                  kind: mb.kind,
                  context: {
                    teamId,
                    teamSlug: teamRow?.name,
                    direction: "out",
                    contactPhone,
                    contactName: contact.name,
                    conversationId: conversation.id,
                    externalId: "pending-meta-send",
                    originalFilename: filename,
                  },
                })
                .catch((err) => {
                  this.logger.error(
                    `[forward] blob upload failed (pre-Meta-send)`,
                    err,
                  );
                  return null;
                }),
            ]);
            const send = await sendMedia(
              {
                to: contactPhone,
                kind: mb.kind,
                mediaId: uploaded.mediaId,
                caption: withCaption,
                filename: mb.kind === "document" ? filename : undefined,
              },
              sendConfig,
            );
            const previewBody = (withCaption || mediaPreview(mb.kind)).slice(
              0,
              200,
            );

            // Monotonicity guard — same fix as text/template/media sends.
            const fwdMediaTs =
              conversation.lastMessageAt && conversation.lastMessageAt >= send.timestamp
                ? new Date(conversation.lastMessageAt.getTime() + 1)
                : send.timestamp;

            const created = await createOutboundMessageIdempotent({
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body: withCaption ?? "",
              direction: "out",
              provider: channel.provider,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
                mediaId: uploaded.mediaId,
                ...(saved ? {} : { blobUploadFailed: true }),
              } as Prisma.InputJsonValue,
              timestamp: fwdMediaTs,
              mediaKind: mb.kind,
              ...(saved
                ? {
                    mediaKey: saved.key,
                    mediaUrl: saved.url,
                    mediaSizeBytes: saved.sizeBytes,
                  }
                : {}),
              mediaMimeType: mb.mime,
              mediaCaption: withCaption ?? null,
              mediaFilename: mb.kind === "document" ? filename : null,
            }).catch((err): null => {
              this.logger.error(
                `[forward] DB persist failed after Meta send (wamid=${send.externalId})`,
                err,
              );
              return null;
            });

            // Even if local persistence broke, count the recipient as sent —
            // Meta confirmed delivery. Skip emit + bump; the inbox catches
            // up on next refresh.
            if (!created) {
              sent++;
              continue;
            }

            const media: MediaAttachment | undefined = saved
              ? {
                  kind: mb.kind,
                  url: `/api/media/${created.id}`,
                  mimeType: mb.mime,
                  sizeBytes: saved.sizeBytes,
                  ...(withCaption ? { caption: withCaption } : {}),
                  ...(mb.kind === "document" ? { filename } : {}),
                }
              : undefined;
            const message: Message = {
              id: created.id,
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body: withCaption ?? "",
              direction: "out",
              provider: channel.provider,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              },
              timestamp: fwdMediaTs.toISOString(),
              ...(media ? { media } : {}),
            };
            await emitForwarded(message, previewBody, fwdMediaTs).catch(
              (err) =>
                this.logger.error(
                  `[forward] emit failed (already sent): ${err instanceof Error ? err.message : err}`,
                ),
            );
          } else {
            const body = (src.body ?? "").trim();
            if (!body) continue; // nothing to forward (shouldn't happen)

            // Pre-send. sendText is a required provider method (always present).
            const send = await binding.provider.sendText(
              { to: contactPhone, body },
              sendConfig,
            );

            // Post-send. Monotonicity guard — see send-text-internal.ts.
            const fwdTextTs =
              conversation.lastMessageAt && conversation.lastMessageAt >= send.timestamp
                ? new Date(conversation.lastMessageAt.getTime() + 1)
                : send.timestamp;
            const created = await createOutboundMessageIdempotent({
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body,
              direction: "out",
              provider: channel.provider,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              } as Prisma.InputJsonValue,
              timestamp: fwdTextTs,
            }).catch((err): null => {
              this.logger.error(
                `[forward] DB persist failed after Meta send (wamid=${send.externalId})`,
                err,
              );
              return null;
            });

            if (!created) {
              sent++;
              continue;
            }

            const preview = body.slice(0, 200);
            const message: Message = {
              id: created.id,
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body,
              direction: "out",
              provider: channel.provider,
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              },
              timestamp: fwdTextTs.toISOString(),
            };
            await emitForwarded(message, preview, fwdTextTs).catch(
              (err) =>
                this.logger.error(
                  `[forward] emit failed (already sent): ${err instanceof Error ? err.message : err}`,
                ),
            );
          }
          sent++;
        } catch (err) {
          failed++;
          firstError ??= describeSendError(err);
          if (!(err instanceof MetaSendError)) {
            this.logger.error("[forward] send failed", err);
          }
          // Any error that fails every remaining send identically (24h
          // window closed / rate limited / auth expired) → bail the
          // per-contact loop so the agent sees the cause once.
          if (isBlockingSendError(err)) break;
        }
      }

      return {
        contactId: contact.id,
        contactName: contact.name,
        ok: failed === 0 && sent > 0,
        sent,
        failed,
        ...(firstError ? { error: firstError } : {}),
      };
    };

    // Bounded fanout. 5 concurrent contacts trades raw wall-time for
    // staying well under Meta's per-phone-number-id send budget on big
    // forwards (e.g. selecting 30 contacts from the picker). Each contact
    // still does 1-3 Meta calls serially internally, so the actual peak
    // request rate is ~5×1 = 5 in-flight to Meta at any moment.
    const FORWARD_CONTACT_CONCURRENCY = 5;
    const results: ForwardResult[] = [];
    for (let i = 0; i < contacts.length; i += FORWARD_CONTACT_CONCURRENCY) {
      const batch = contacts.slice(i, i + FORWARD_CONTACT_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(processContact));
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j]!;
        const c = batch[j]!;
        if (r.status === "fulfilled") {
          results.push(r.value);
        } else {
          // Defensive: processContact catches its own send errors and
          // returns a structured result. A rejection here means something
          // outside that loop threw (DB transaction, refs fetch, etc.).
          this.logger.error(
            `[forward] contact ${c.id} crashed: ${
              r.reason instanceof Error ? r.reason.message : String(r.reason)
            }`,
            r.reason instanceof Error ? r.reason : undefined,
          );
          results.push({
            contactId: c.id,
            contactName: c.name,
            ok: false,
            sent: 0,
            failed: sourceRows.length,
            error: "internal error",
          });
        }
      }
    }

    return { results };
  }

  /**
   * Template send. Delegates to lib/messaging/send-template-internal which
   * is also called by the `send_template` workflow step — the route and
   * the workflow path produce identical message rows.
   */
  async sendTemplate(
    teamId: string,
    userId: string,
    input: SendTemplateInput,
  ): Promise<{ messageId: string }> {
    return runWithSendIdempotency(
      {
        teamId,
        userId,
        conversationId: input.conversationId,
        clientTempId: input.clientTempId,
      },
      () => this.sendTemplateInner(teamId, userId, input),
    );
  }

  private async sendTemplateInner(
    teamId: string,
    userId: string,
    input: SendTemplateInput,
  ): Promise<{ messageId: string }> {
    try {
      const result = await sendTemplateInternal({
        teamId,
        conversationId: input.conversationId,
        templateId: input.templateId,
        variables: input.variables,
        senderUserId: userId,
        sentVia: "api/messages/template",
      });
      return { messageId: result.messageId };
    } catch (err) {
      if (err instanceof SendTemplateValidationError) {
        throw new HttpException(
          { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
          TEMPLATE_ERROR_STATUS[err.code],
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      this.logger.error("template send failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Agent-side interactive send. Synchronous (no BullMQ queue) — interactive
   * sends are rare admin moves vs. high-volume text replies, so the latency
   * extra of an inline Meta call (~300ms) doesn't justify the queue
   * scaffolding overhead. Reuses sendInteractiveInternal which already
   * handles the 24h-window gate, conversation bump, and `message.sent`
   * outbox publish.
   *
   * `senderUserId` is captured on the message row so attribution works
   * the same way as for text replies — the inbox shows "Agent name" on
   * the outbound bubble.
   */
  async sendInteractive(
    teamId: string,
    userId: string,
    input: import("./messages.schemas").SendInteractiveInput,
  ): Promise<{ messageId: string }> {
    try {
      const result = await sendInteractiveInternal({
        teamId,
        conversationId: input.conversationId,
        bodyText: input.body,
        kind: input.kind,
        options: input.options,
        ...(input.listCtaLabel ? { listCtaLabel: input.listCtaLabel } : {}),
        senderUserId: userId,
        sentVia: "api/messages/interactive",
      });
      return { messageId: result.messageId };
    } catch (err) {
      if (err instanceof SendTextValidationError) {
        const status =
          err.code === "outside_24h_window"
            ? 422
            : err.code === "provider_not_configured"
              ? 422
              : err.code === "conversation_not_found"
                ? 404
                : 400;
        throw new HttpException(
          { error: err.code, ...(err.detail ? { detail: err.detail } : {}) },
          status,
        );
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        });
      }
      this.logger.error("interactive send failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function describeSendError(err: unknown): string {
  const normalized = normalizeMetaSendError(err);
  if (normalized) return normalized.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Errors that fail every subsequent send IDENTICALLY for the same contact:
 * the 24h-window is closed, Meta's rate-limit gate has tripped, or the team's
 * access token has expired. Hammering Meta with more requests just turns the
 * forward into a wall of identical failures (and may burn quality rating).
 * Bail on the per-contact loop so the agent sees the real cause once instead
 * of N times.
 */
function isBlockingSendError(err: unknown): boolean {
  const code = normalizeMetaSendError(err)?.code;
  return (
    code === "outside_24h_window" ||
    code === "rate_limited" ||
    code === "auth_expired"
  );
}

function captionable(kind: MediaKind): boolean {
  return kind === "image" || kind === "video" || kind === "document";
}

const TEMPLATE_ERROR_STATUS: Record<SendTemplateValidationError["code"], number> = {
  conversation_not_found: 404,
  template_not_found: 404,
  template_not_approved: 409,
  wrong_body_var_count: 400,
  header_var_required: 400,
  contact_has_no_phone: 400,
  provider_not_configured: 409,
  provider_no_template_support: 501,
};
