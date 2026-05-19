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
import { publishInTx } from "@/lib/events/outbox";
import type { DomainEventOf } from "@ccp/shared/events/types";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import {
  consumeConversationSendBudget,
  ConversationSendRateLimitedError,
} from "@/lib/messaging/conversation-send-budget";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
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
   * CAS-bump on lastMessageAt so an out-of-order older send can't
   * overwrite a newer one's preview.
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
    event: Omit<DomainEventOf<"message.sent">, "unreadCount">;
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await tx.conversation.updateMany({
        where: {
          id: args.conversationId,
          lastMessageAt: { lte: args.bumpTimestamp },
        },
        data: {
          lastMessageAt: args.bumpTimestamp,
          lastMessagePreview: args.preview,
        },
      });
      const row = await tx.conversation.findUnique({
        where: { id: args.conversationId },
        select: { unreadCount: true },
      });
      const unreadCount = row?.unreadCount ?? 0;
      await publishInTx(tx, { ...args.event, unreadCount });
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
    phoneNumber: string;
    replyToMessageId: string | null;
    replyToExternalId?: string;
  }> {
    const { conversationId, replyToMessageId: replyToMessageIdRaw } = input;
    const [conversation, replyToRow, configOrErr] = await Promise.all([
      this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: {
          id: true,
          contact: { select: { phoneNumber: true, lastInboundAt: true } },
        },
      }),
      replyToMessageIdRaw
        ? this.db.message.findFirst({
            where: { id: replyToMessageIdRaw, conversationId, teamId },
            select: { id: true, externalId: true },
          })
        : Promise.resolve(null),
      getMetaSendConfig(teamId).catch((err: unknown) => {
        if (err instanceof ProviderNotConfiguredError) return err;
        throw err;
      }),
    ]);
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    if (configOrErr instanceof ProviderNotConfiguredError) {
      throw new ConflictException({
        error: "whatsapp_not_connected",
        detail: configOrErr.message,
      });
    }
    if (!conversation.contact.phoneNumber) {
      throw new BadRequestException({
        error: "contact_has_no_phone",
        detail: "This contact has no WhatsApp number.",
      });
    }
    const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
    const win = computeWindowStatus(lastInboundAt);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail: "24-hour window closed — send an approved template to re-engage this contact.",
        lastInboundAt,
      });
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
    return {
      phoneNumber: conversation.contact.phoneNumber,
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
  async executeTextSendJob(data: import("./send-queue").SendTextJobData): Promise<void> {
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

    // Cheap indexed existence check (no contact join, no select-all).
    // Conversation row gone → fail non-recoverable BEFORE we hit Meta so
    // we don't strand a customer with a message no agent can see.
    const [exists, configOrErr] = await Promise.all([
      this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: { id: true },
      }),
      getMetaSendConfig(teamId).catch((err: unknown) => {
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

    let send;
    try {
      send = await getMetaProvider().sendText(
        {
          to: phoneNumber,
          body,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
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

    const [created, replySnapshot] = await Promise.all([
      createOutboundMessageIdempotent({
        teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: userId,
        body,
        direction: "out",
        provider: "meta_cloud",
        status: "sent",
        rawPayload: { sentVia: "api/messages" } as Prisma.InputJsonValue,
        timestamp: receivedAt,
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
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/messages" },
      timestamp: receivedAt.toISOString(),
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
        bumpTimestamp: send.timestamp,
        preview,
        event: {
          type: "message.sent",
          teamId,
          conversationId,
          message,
          preview,
          lastMessageAt: send.timestamp.toISOString(),
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
        contact: {
          select: { phoneNumber: true, name: true, lastInboundAt: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // 24h window — media (like free-form text) is template-only outside it.
    const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
    const win = computeWindowStatus(lastInboundAt);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail:
          "24-hour window closed — media can't be sent freely. Use an approved template to re-engage.",
        lastInboundAt,
      });
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

    const mimeType = file.mimetype || "application/octet-stream";
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

    // Read the disk-backed multer temp file ONCE into a single Buffer that
    // both Meta upload + blob-storage upload share. file.buffer is empty
    // under diskStorage; file.path is the temp location set by the
    // controller's diskStorage config. The previous memoryStorage code
    // path pinned ~3x file size in V8 heap during the parallel uploads
    // (multer buffer + Meta Blob copy + blob-storage Blob copy); reading
    // once here + reusing the buffer drops peak to ~1x while the two
    // providers run, since both internal Blobs copy from the same source
    // synchronously per provider but the source itself is shared.
    const bytes = new Uint8Array(await readFile(file.path));
    const filename = file.originalname || "upload";

    if (!conversation.contact.phoneNumber) {
      throw new BadRequestException({
        error: "contact_has_no_phone",
        detail: "This contact has no WhatsApp number.",
      });
    }
    const toPhone = conversation.contact.phoneNumber;
    const toName = conversation.contact.name;

    let sendConfig;
    try {
      sendConfig = await getMetaSendConfig(teamId);
    } catch (err) {
      throw new ConflictException({
        error: "WhatsApp is not connected for this team",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

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
      const uploaded = await getMetaProvider().uploadMedia!(
        { bytes, mimeType, filename },
        sendConfig,
      );
      mediaId = uploaded.mediaId;
    } catch (err) {
      // Don't let the parallel blob upload leak as an unhandledRejection on
      // the early-return path.
      blobUploadPromise.catch(() => {});
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
      send = await getMetaProvider().sendMedia!(
        {
          to: toPhone,
          kind,
          mediaId,
          caption: caption || undefined,
          filename: kind === "document" ? filename : undefined,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        sendConfig,
      );
    } catch (err) {
      blobUploadPromise.catch(() => {});
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

    const created = await createOutboundMessageIdempotent({
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: userId,
      body: caption,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: {
        sentVia: "api/messages/media",
        mediaId,
        ...(saved ? {} : { blobUploadFailed: true }),
      } as Prisma.InputJsonValue,
      timestamp: receivedAt,
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
      provider: "meta_cloud",
      status: "sent",
      rawPayload: {
        sentVia: "api/messages/media",
        mediaId,
        ...(saved ? {} : { blobUploadFailed: true }),
      },
      timestamp: receivedAt.toISOString(),
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
        bumpTimestamp: send.timestamp,
        preview: previewBody,
        event: {
          type: "message.sent",
          teamId,
          conversationId,
          message,
          preview: previewBody,
          lastMessageAt: send.timestamp.toISOString(),
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

    let sendConfig;
    try {
      sendConfig = await getMetaSendConfig(teamId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp not connected",
          detail: err.message,
        });
      }
      throw err;
    }

    const contacts = await this.db.contact.findMany({
      where: { id: { in: contactIds }, teamId },
      include: { tags: { select: { id: true } } },
    });
    if (contacts.length === 0) {
      throw new NotFoundException({ error: "no such contacts" });
    }

    // Cache source-media bytes across recipients. `null` is cached too — a
    // missing/unreadable file shouldn't be retried per-recipient.
    type MediaBytes = {
      bytes: Uint8Array;
      mime: string;
      filename: string | null;
      kind: MediaKind;
    };
    const mediaCache = new Map<string, MediaBytes | null>();
    const loadMediaBytes = async (
      m: (typeof sourceRows)[number],
    ): Promise<MediaBytes | null> => {
      if (mediaCache.has(m.id)) return mediaCache.get(m.id)!;
      let entry: MediaBytes | null = null;
      // Prefer mediaUrl (CDN URL — single hop). Fall back to mediaKey for
      // rows that predate the URL column. Same provider either way.
      const handle = m.mediaUrl ?? m.mediaKey;
      if (handle && m.mediaKind) {
        try {
          const fetched = await blobStorage.fetch(handle);
          entry = {
            bytes: fetched.bytes,
            mime: m.mediaMimeType ?? fetched.mimeType,
            filename: m.mediaFilename ?? null,
            kind: m.mediaKind as MediaKind,
          };
        } catch {
          entry = null;
        }
      }
      mediaCache.set(m.id, entry);
      return entry;
    };

    const teamRow = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    const results: ForwardResult[] = [];

    for (const contact of contacts) {
      if (!contact.phoneNumber) {
        results.push({
          contactId: contact.id,
          contactName: contact.name,
          ok: false,
          sent: 0,
          failed: sourceRows.length,
          error: "contact has no WhatsApp phone number",
        });
        continue;
      }
      const contactPhone = contact.phoneNumber;

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
            message,
            preview,
            lastMessageAt: bumpTimestamp.toISOString(),
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

            // Pre-send.
            const uploaded = await getMetaProvider().uploadMedia!(
              { bytes: mb.bytes, mimeType: mb.mime, filename },
              sendConfig,
            );
            const send = await getMetaProvider().sendMedia!(
              {
                to: contactPhone,
                kind: mb.kind,
                mediaId: uploaded.mediaId,
                caption: withCaption,
                filename: mb.kind === "document" ? filename : undefined,
              },
              sendConfig,
            );

            // Post-send: local-state-only from here on.
            const saved = await blobStorage
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
                  externalId: send.externalId,
                  originalFilename: filename,
                },
              })
              .catch((err) => {
                this.logger.error(
                  `[forward] blob upload failed after Meta send (wamid=${send.externalId})`,
                  err,
                );
                return null;
              });
            const previewBody = (withCaption || mediaPreview(mb.kind)).slice(
              0,
              200,
            );

            const created = await createOutboundMessageIdempotent({
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body: withCaption ?? "",
              direction: "out",
              provider: "meta_cloud",
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
                mediaId: uploaded.mediaId,
                ...(saved ? {} : { blobUploadFailed: true }),
              } as Prisma.InputJsonValue,
              timestamp: send.timestamp,
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
              provider: "meta_cloud",
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              },
              timestamp: send.timestamp.toISOString(),
              ...(media ? { media } : {}),
            };
            await emitForwarded(message, previewBody, send.timestamp).catch(
              (err) =>
                this.logger.error(
                  `[forward] emit failed (already sent): ${err instanceof Error ? err.message : err}`,
                ),
            );
          } else {
            const body = (src.body ?? "").trim();
            if (!body) continue; // nothing to forward (shouldn't happen)

            // Pre-send.
            const send = await getMetaProvider().sendText(
              { to: contactPhone, body },
              sendConfig,
            );

            // Post-send.
            const created = await createOutboundMessageIdempotent({
              teamId,
              conversationId: conversation.id,
              externalId: send.externalId,
              senderUserId: userId,
              body,
              direction: "out",
              provider: "meta_cloud",
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              } as Prisma.InputJsonValue,
              timestamp: send.timestamp,
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
              provider: "meta_cloud",
              status: "sent",
              rawPayload: {
                sentVia: "api/messages/forward",
                forwardedFrom: src.id,
              },
              timestamp: send.timestamp.toISOString(),
            };
            await emitForwarded(message, preview, send.timestamp).catch(
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

      results.push({
        contactId: contact.id,
        contactName: contact.name,
        ok: failed === 0 && sent > 0,
        sent,
        failed,
        ...(firstError ? { error: firstError } : {}),
      });
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
