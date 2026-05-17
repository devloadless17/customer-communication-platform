import { randomUUID } from "node:crypto";

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
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
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
import { PrismaService } from "../prisma/prisma.service";
import type {
  ForwardMessagesInput,
  SendMediaFormInput,
  SendTemplateInput,
  SendTextInput,
} from "./messages.schemas";

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Free-form text send. Mirrors /api/messages POST exactly. Phases:
   *
   *   A. Parallel pre-flight reads (conversation, replyTo, send config, last inbound).
   *   B. Meta sendText (200–800ms hop). Reply-snapshot prefetch in parallel.
   *   C. Idempotent DB insert + snapshot finalize.
   *   D. Publish `message.sent` (awaited so socket emit reaches clients before
   *      we return — preserves the sender-bubble swap UX).
   */
  async sendText(
    teamId: string,
    userId: string,
    input: SendTextInput,
  ): Promise<{ messageId: string }> {
    // Stamp logical send time at request arrival (not at Meta's response)
    // — preserves the user's actual send sequence on reloads.
    const receivedAt = new Date();
    const { conversationId, body, clientTempId, replyToMessageId: replyToMessageIdRaw } = input;

    // Phase A — parallel pre-flight reads.
    const [conversation, replyToRow, configOrErr, lastInbound] = await Promise.all([
      this.prisma.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: { id: true, contact: { select: { phoneNumber: true } } },
      }),
      replyToMessageIdRaw
        ? this.prisma.message.findFirst({
            where: { id: replyToMessageIdRaw, conversationId, teamId },
            select: { id: true, externalId: true },
          })
        : Promise.resolve(null),
      getMetaSendConfig(teamId).catch((err: unknown) => {
        if (err instanceof ProviderNotConfiguredError) return err;
        throw err;
      }),
      this.prisma.message.findFirst({
        where: { conversationId, direction: "in" },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
    ]);

    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    if (configOrErr instanceof ProviderNotConfiguredError) {
      throw new ConflictException({
        error: "whatsapp_not_connected",
        detail: configOrErr.message,
      });
    }
    const config = configOrErr;

    // 24h customer service window — outbound text is illegal outside it.
    const win = computeWindowStatus(lastInbound?.timestamp.toISOString() ?? null);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail: "24-hour window closed — send an approved template to re-engage this contact.",
        lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
      });
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (replyToRow) {
      replyToMessageId = replyToRow.id;
      // Don't forward a placeholder externalId to Meta (would 400 it). The
      // reply snapshot still resolves locally; we just don't quote on the
      // wire when the parent is still pending-send.
      if (!replyToRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyToRow.externalId;
      }
    }

    if (!conversation.contact.phoneNumber) {
      throw new BadRequestException({
        error: "contact_has_no_phone",
        detail: "This contact has no WhatsApp number.",
      });
    }

    // Phase B — Meta send + parallel reply snapshot prefetch.
    const replySnapshotPromise = replyToMessageId
      ? loadReplySnapshotById(replyToMessageId)
      : Promise.resolve(null);

    let send;
    try {
      send = await getMetaProvider().sendText(
        {
          to: conversation.contact.phoneNumber,
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

    // Phase C — DB write + snapshot finalize, in parallel.
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

    // Phase D — publish. Awaited so socket emit reaches active clients
    // before the response, preserving the sender's bubble-swap UX.
    await this.bus.publish({
      type: "message.sent",
      teamId,
      conversationId,
      message,
      preview,
      lastMessageAt: send.timestamp.toISOString(),
      unreadDelta: 0,
      senderUserId: userId,
      ...(clientTempId ? { clientTempId } : {}),
    });

    // Bump conversation's lastMessageAt/preview for the next cold load.
    // Fire-and-forget — live clients already have it from the socket emit.
    void this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
      })
      .catch((err) =>
        this.logger.error(`deferred conversation.update failed: ${err instanceof Error ? err.message : err}`),
      );

    return { messageId: created.id };
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
    const receivedAt = new Date();
    const { conversationId, caption, clientTempId, replyToMessageId: replyToMessageIdRaw } = form;

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { contact: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // 24h window — media (like free-form text) is template-only outside it.
    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });
    const win = computeWindowStatus(lastInbound?.timestamp.toISOString() ?? null);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail:
          "24-hour window closed — media can't be sent freely. Use an approved template to re-engage.",
        lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
      });
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (replyToMessageIdRaw) {
      const replyToRow = await this.prisma.message.findFirst({
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

    const bytes = new Uint8Array(file.buffer);
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
    const teamRowPromise = this.prisma.team
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

    // Conversation summary bump — fire-and-forget. The socket emit below
    // already carries everything an active client needs.
    void this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { lastMessageAt: send.timestamp, lastMessagePreview: previewBody },
      })
      .catch((err) =>
        this.logger.error(
          `deferred conversation.update failed: ${err instanceof Error ? err.message : err}`,
        ),
      );

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

    // Publish through the bus — socket-fanout pushes the bubble AND analytics
    // stamps firstResponseAt / bumps outgoingMessagesCount. Note: pre-migration
    // direct-emit path skipped analytics; this migration starts counting media
    // sends as outbound for response-time + counter metrics, which is the
    // correct behavior (a media send is an outbound message for every other
    // purpose).
    await this.bus.publish({
      type: "message.sent",
      teamId,
      conversationId,
      message,
      preview: previewBody,
      lastMessageAt: send.timestamp.toISOString(),
      unreadDelta: 0,
      senderUserId: userId,
      ...(clientTempId ? { clientTempId } : {}),
    });

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
   * Behavior change vs the pre-migration direct-emit path: forwards now
   * flow through the analytics subscriber, so each forwarded message counts
   * toward outgoingMessagesCount + stamps firstResponseAt when prior
   * inbound exists. That matches text-send semantics; the prior path
   * silently skipped analytics, which was an oversight.
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
    const sourceRows = await this.prisma.message.findMany({
      where: { id: { in: messageIds }, teamId, status: { not: "failed" } },
      orderBy: { timestamp: "asc" },
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

    const contacts = await this.prisma.contact.findMany({
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

    const teamRow = await this.prisma.team.findUnique({
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
      const existing = await this.prisma.conversation.findFirst({
        where: { teamId, contactId: contact.id },
        orderBy: { lastMessageAt: "desc" },
      });
      const conversation = !existing
        ? await this.prisma.conversation.create({
            data: {
              teamId,
              contactId: contact.id,
              status: "pending",
              lastMessagePreview: "",
            },
          })
        : existing.status === "closed"
          ? await this.prisma.conversation.update({
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
      // so inbox lists can splice the row in without a refetch.
      const emitForwarded = async (
        message: Message,
        preview: string,
        ts: string,
      ): Promise<void> => {
        let newConversation: ConversationWithRefs | undefined;
        if (conversationIsNew && !emittedForConversation) {
          const refs = await getConversationWithRefs(teamId, conversation.id, {
            messageLimit: 1,
          });
          if (refs) newConversation = refs.data;
        }
        emittedForConversation = true;
        await this.bus.publish({
          type: "message.sent",
          teamId,
          conversationId: conversation.id,
          message,
          preview,
          lastMessageAt: ts,
          unreadDelta: 0,
          senderUserId: userId,
          ...(newConversation ? { newConversation } : {}),
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

            void this.prisma.conversation
              .update({
                where: { id: conversation.id },
                data: {
                  lastMessageAt: send.timestamp,
                  lastMessagePreview: previewBody,
                },
              })
              .catch((err) =>
                this.logger.error(
                  `[forward] deferred conversation.update failed: ${err instanceof Error ? err.message : err}`,
                ),
              );

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
            await emitForwarded(
              message,
              previewBody,
              send.timestamp.toISOString(),
            ).catch((err) =>
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
            void this.prisma.conversation
              .update({
                where: { id: conversation.id },
                data: {
                  lastMessageAt: send.timestamp,
                  lastMessagePreview: preview,
                },
              })
              .catch((err) =>
                this.logger.error(
                  `[forward] deferred conversation.update failed: ${err instanceof Error ? err.message : err}`,
                ),
              );

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
            await emitForwarded(
              message,
              preview,
              send.timestamp.toISOString(),
            ).catch((err) =>
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
          // Closed window fails every remaining send for this contact —
          // don't hammer Meta with guaranteed-fail requests.
          if (isWindowClosed(err)) break;
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

function isWindowClosed(err: unknown): boolean {
  return normalizeMetaSendError(err)?.code === "outside_24h_window";
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
