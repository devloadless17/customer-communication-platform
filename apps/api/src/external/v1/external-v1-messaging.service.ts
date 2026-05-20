import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import {
  toExternalConversation,
  toExternalContact,
  toExternalMessage,
  type ExternalMessage,
} from "@/lib/external-shapes";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";

import { refundApiKeyBucket } from "../../auth/api-key.guard";
import {
  sendTemplateInternal,
  SendTemplateValidationError,
} from "@/lib/messaging/send-template-internal";
import {
  consumeConversationSendBudget,
  ConversationSendRateLimitedError,
} from "@/lib/messaging/conversation-send-budget";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import type { Message, User } from "@ccp/shared/types";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import { computeWindowStatus } from "@ccp/shared/utils/window";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  ExternalAssignInput,
  ExternalContactAssignInput,
  ExternalContactStatusInput,
  ExternalNoteInput,
  ExternalSendMessageInput,
  ExternalStatusInput,
  ExternalTopLevelSendMessageInput,
  ListConversationsQueryInput,
  ListMessagesQueryInput,
} from "./external-v1.schemas";

/**
 * Extracted from the original `external-v1.service.ts` to keep file sizes
 * tractable. Holds every conversation-/message-/note-/send-shaped route on
 * the external `/v1` surface; the parent `ExternalV1Service` delegates to
 * an instance of this class via DI.
 *
 * No behavior changes vs the previous monolith — same event publish shapes,
 * same audit-attribution discipline (`changedByApiKeyId` / `senderApiKeyId`
 * threaded through every domain event the partner triggers).
 */
@Injectable()
export class ExternalV1MessagingService {
  private readonly logger = new Logger(ExternalV1MessagingService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  // ===========================================================================
  // CONVERSATIONS
  // ===========================================================================

  async listConversations(teamId: string, q: ListConversationsQueryInput) {
    const rows = await this.db.conversation.findMany({
      where: {
        teamId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.phone ? { contact: { phoneNumber: q.phone } } : {}),
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalConversation);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  async getConversation(teamId: string, id: string) {
    const row = await this.db.conversation.findFirst({
      where: { id, teamId },
      include: { contact: { include: { tags: { select: { id: true } } } } },
    });
    if (!row) throw new NotFoundException({ error: "conversation not found" });
    return {
      conversation: toExternalConversation(row),
      contact: toExternalContact(row.contact, row.contact.tags.map((t) => t.id)),
    };
  }

  async assign(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalAssignInput,
  ) {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        assignedUserId: true,
        status: true,
        contact: { include: { tags: { select: { id: true } } } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const previousAssignedUserId = conversation.assignedUserId;
    const previousStatus = conversation.status;

    if (input.assignedUserId !== null) {
      // Mirror the UI route's guard (conversations.service.ts:assign): refuse
      // to assign to a deactivated agent. Without `deactivatedAt: null`, a
      // partner integration could strand a thread with a soft-deleted owner
      // who'll never see it in any queue.
      const member = await this.db.user.findFirst({
        where: { id: input.assignedUserId, teamId, deactivatedAt: null },
        select: { id: true },
      });
      if (!member) throw new BadRequestException({ error: "user not in team" });
    }

    // Mirror conversations.service.ts:assign — assignment carries an
    // ownership signal so the status auto-flips on the two transitions
    // worth automating. Kept identical between routes so a UI click + a
    // partner /v1 POST produce the same end state.
    let nextStatus: typeof previousStatus = previousStatus;
    if (input.assignedUserId !== null && previousStatus === "closed") {
      nextStatus = "open";
    } else if (input.assignedUserId === null && previousStatus === "open") {
      nextStatus = "pending";
    }
    const statusChanged = nextStatus !== previousStatus;

    // CAS on previous assignee + status. Mirrors the UI route so a concurrent
    // UI click and /v1 call converge on the same race-loser-409 behavior,
    // instead of the /v1 update silently clobbering a fresh UI assignment
    // (or a fresh manual close in the brief window before our write lands).
    let updated;
    try {
      updated = await this.db.conversation.update({
        where: {
          id: conversationId,
          teamId,
          assignedUserId: previousAssignedUserId,
          status: previousStatus,
        },
        data: statusChanged
          ? { assignedUserId: input.assignedUserId, status: nextStatus }
          : { assignedUserId: input.assignedUserId },
        include: { assignedUser: true },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        throw new ConflictException({ error: "conversation was reassigned by someone else" });
      }
      throw err;
    }

    const assignedUser: User | null = updated.assignedUser
      ? {
          id: updated.assignedUser.id,
          teamId: updated.assignedUser.teamId,
          role: updated.assignedUser.role,
          name: updated.assignedUser.name,
          email: updated.assignedUser.email,
          avatarUrl: updated.assignedUser.avatarUrl ?? undefined,
          isActive: updated.assignedUser.deactivatedAt === null,
        }
      : null;

    await this.bus.publish({
      type: "conversation.assigned",
      teamId,
      conversationId,
      assignedUser,
      previousAssignedUserId,
      newAssignedUserId: input.assignedUserId,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      contact: workflowContactSnapshot(conversation.contact),
    });

    if (statusChanged) {
      await this.bus.publish({
        type: "conversation.status_changed",
        teamId,
        conversationId,
        previousStatus,
        newStatus: nextStatus,
        changedByUserId: null,
        changedByApiKeyId: apiKeyId,
        contact: workflowContactSnapshot(conversation.contact),
      });
    }
  }

  async setStatus(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalStatusInput,
  ) {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { contact: { include: { tags: { select: { id: true } } } } },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const previousStatus = conversation.status;

    await this.db.conversation.update({
      where: { id: conversationId },
      data: { status: input.status },
    });

    await this.bus.publish({
      type: "conversation.status_changed",
      teamId,
      conversationId,
      previousStatus,
      newStatus: input.status,
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      contact: workflowContactSnapshot(conversation.contact),
    });
  }

  // ===========================================================================
  // MESSAGES
  // ===========================================================================

  async listMessages(
    teamId: string,
    conversationId: string,
    q: ListMessagesQueryInput,
  ) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    const rows = await this.db.message.findMany({
      where: { conversationId },
      // toExternalMessage uses 8 fields; rawPayload (Meta JSONB, 5-20KB/row)
      // would ship to the integrator on every page otherwise.
      omit: { rawPayload: true },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalMessage);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  async findMessage(teamId: string, id: string) {
    const row = await this.db.message.findFirst({
      where: { id, teamId },
      omit: { rawPayload: true },
    });
    if (!row) throw new NotFoundException({ error: "message not found" });
    return { message: toExternalMessage(row) };
  }

  async sendMessage(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    /** Optional idempotency key from the `Idempotency-Key` request header. */
    idempotencyKey?: string,
  ) {
    // Idempotency — CLAIM-then-execute, not execute-then-record.
    //
    // The prior pattern (read cache → send to Meta → fire-and-forget upsert)
    // left a wide race window: a partner retry between the Meta call and the
    // background upsert would not see the cache yet, re-send the message,
    // and produce a duplicate customer-facing WhatsApp delivery.
    //
    // Now: insert a row with `responseStatus: 0` (sentinel = pending) before
    // any side effect. The unique index on (teamId, apiKeyId, key) makes
    // the insert serve as a row-level lock — concurrent retries see P2002
    // and read whatever row the winner committed. After the Meta send +
    // DB writes, we UPDATE the row with the real response body + status
    // + extend expiresAt to 24h. On send failure, DELETE so a retry can
    // claim fresh.
    //
    // Pending TTL is short (5min) so a crashed handler doesn't permanently
    // shadow the key — the sweeper at lib/sweepers/api-idempotency-cleanup
    // garbage-collects expired pending rows too.
    const PENDING_STATUS = 0;
    const PENDING_TTL_MS = 5 * 60_000;
    const COMPLETED_TTL_MS = 24 * 60 * 60_000;
    if (idempotencyKey) {
      try {
        await this.db.apiIdempotencyKey.create({
          data: {
            teamId,
            apiKeyId,
            key: idempotencyKey,
            responseBody: { _pending: true } as Prisma.InputJsonValue,
            responseStatus: PENDING_STATUS,
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          },
        });
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          // Another request already claimed this key. Read its state.
          const cached = await this.db.apiIdempotencyKey.findUnique({
            where: {
              teamId_apiKeyId_key: { teamId, apiKeyId, key: idempotencyKey },
            },
            select: { responseBody: true, responseStatus: true, expiresAt: true },
          });
          if (!cached) {
            // Vanished between P2002 and the read (sweeper / manual delete).
            // Surface as 409 — partner can retry, which will re-claim cleanly.
            throw new ConflictException({
              error: "idempotency_in_progress",
              detail: "Concurrent retry race — try again in a moment.",
            });
          }
          if (cached.responseStatus === PENDING_STATUS) {
            if (cached.expiresAt > new Date()) {
              throw new ConflictException({
                error: "idempotency_in_progress",
                detail:
                  "A previous request with this Idempotency-Key is still in flight. " +
                  "Retry in a few seconds.",
              });
            }
            // Stale pending row past TTL — clear and re-claim. Race with the
            // sweeper is harmless because deleteMany is no-op when zero rows.
            await this.db.apiIdempotencyKey.deleteMany({
              where: { teamId, apiKeyId, key: idempotencyKey },
            });
            // Loop back into the create path on caller retry; simplest is to
            // tell the partner so the next request gets a clean claim.
            throw new ConflictException({
              error: "idempotency_in_progress",
              detail: "Stale pending claim cleared — retry.",
            });
          }
          if (cached.expiresAt > new Date()) {
            // Refund the API-key token — the request did zero real work,
            // so it shouldn't burn quota. A partner with a crashing
            // handler retrying the same Idempotency-Key for 24h would
            // otherwise drain 60 tokens/min on cache reads alone.
            refundApiKeyBucket(apiKeyId);
            return cached.responseBody as unknown as { message: ExternalMessage };
          }
          // Expired completed row — fall through to re-claim. Delete first
          // so the create below doesn't P2002 again.
          await this.db.apiIdempotencyKey.deleteMany({
            where: { teamId, apiKeyId, key: idempotencyKey },
          });
          await this.db.apiIdempotencyKey.create({
            data: {
              teamId,
              apiKeyId,
              key: idempotencyKey,
              responseBody: { _pending: true } as Prisma.InputJsonValue,
              responseStatus: PENDING_STATUS,
              expiresAt: new Date(Date.now() + PENDING_TTL_MS),
            },
          });
        } else {
          throw err;
        }
      }
    }

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        contact: { select: { phoneNumber: true, lastInboundAt: true } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
    const win = computeWindowStatus(lastInboundAt);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail:
          "free-form messages are only allowed within 24h of the contact's last inbound. " +
          "use a pre-approved template for cold outbound (not yet exposed via the external API).",
        lastInboundAt,
      });
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (input.replyToMessageId) {
      const replyRow = await this.db.message.findFirst({
        where: { id: input.replyToMessageId, conversationId, teamId },
        select: { id: true, externalId: true },
      });
      if (!replyRow) {
        // Previously silently dropped — partner thought their reply was
        // quoted but the message went out as a top-level send. Surface
        // the failure so they can see the bad id in their automation logs.
        throw new BadRequestException({
          error: "reply_target_not_found",
          detail:
            "replyToMessageId does not match a message in this conversation. " +
            "It may have been deleted, belongs to a different conversation, or " +
            "is owned by a different team.",
        });
      }
      replyToMessageId = replyRow.id;
      if (!replyRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyRow.externalId;
      }
    }

    if (!conversation.contact.phoneNumber) {
      throw new BadRequestException({
        error: "contact_has_no_phone",
        detail: "This contact has no WhatsApp number.",
      });
    }

    // Per-conversation send ceiling. Bounds a partner-driven hot-potato
    // (their automation reacts to its own `message.sent` webhook and POSTs
    // back) inside one thread before the per-key 60/min budget bites. See
    // lib/messaging/conversation-send-budget.ts for rationale. The
    // idempotency claim above this point already committed; if rate-limit
    // throws here, the calling partner can release + retry after the
    // Retry-After window expires.
    try {
      consumeConversationSendBudget(teamId, conversationId);
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        // Release the idempotency claim so the partner's retry after
        // Retry-After expires can re-claim a fresh slot.
        if (idempotencyKey) {
          await this.db.apiIdempotencyKey
            .deleteMany({
              where: {
                teamId,
                apiKeyId,
                key: idempotencyKey,
                responseStatus: PENDING_STATUS,
              },
            })
            .catch(() => {
              /* best-effort */
            });
        }
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

    let send;
    try {
      const config = await getMetaSendConfig(teamId);
      send = await getMetaProvider().sendText(
        {
          to: conversation.contact.phoneNumber,
          body: input.body,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
      // Send failed — release the idempotency claim so the partner can
      // retry. Without this, the row stays in `pending` state for the full
      // PENDING_TTL_MS and every retry inside that window gets 409.
      if (idempotencyKey) {
        await this.db.apiIdempotencyKey
          .deleteMany({
            where: {
              teamId,
              apiKeyId,
              key: idempotencyKey,
              responseStatus: PENDING_STATUS,
            },
          })
          .catch(() => {
            /* best-effort */
          });
      }
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp_not_connected",
          detail: err.message,
        });
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        throw new UnprocessableEntityException({
          error: normalized.code,
          detail: `Meta ${normalized.httpStatus}: ${normalized.message}${
            normalized.detail ? ` — ${normalized.detail}` : ""
          }`,
        });
      }
      this.logger.error("external sendText failed", err);
      throw new BadGatewayException({
        error: "send_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    const created = await createOutboundMessageIdempotent({
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: null,
      body: input.body,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId } as Prisma.InputJsonValue,
      timestamp: send.timestamp,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });

    const preview = input.body.slice(0, 200);
    // Read-then-write so a concurrent inbound that landed during the Meta
    // call doesn't get regressed backward in time by this bare UPDATE.
    // Without the +1ms guard, the partner's send timestamp can be older
    // than the inbound's, and writing it would flip inbox sort order.
    const bumped = await this.db.$transaction(async (tx) => {
      const current = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { lastMessageAt: true, unreadCount: true },
      });
      if (!current) {
        throw new BadGatewayException({
          error: "conversation_disappeared_mid_send",
        });
      }
      const effectiveBump =
        current.lastMessageAt >= send.timestamp
          ? new Date(current.lastMessageAt.getTime() + 1)
          : send.timestamp;
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: effectiveBump, lastMessagePreview: preview },
      });
      return { lastMessageAt: effectiveBump, unreadCount: current.unreadCount };
    });

    const message: Message = {
      id: created.id,
      teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: null,
      body: input.body,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId },
      timestamp: send.timestamp.toISOString(),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };

    await this.bus.publish({
      type: "message.sent",
      teamId,
      conversationId,
      message,
      preview,
      // Use the effective bump so the frontend's lastMessageAt stays in
      // sync with DB even when the +1ms guard kicked in above.
      lastMessageAt: bumped.lastMessageAt.toISOString(),
      // Outbound doesn't bump unread; the row's current value is the
      // accurate absolute count.
      unreadCount: bumped.unreadCount,
      senderUserId: null,
      senderApiKeyId: apiKeyId,
    });

    const result = { message: toExternalMessage(created) };

    if (idempotencyKey) {
      // Complete the claim — flip the pending sentinel to the real response.
      // AWAITED (not fire-and-forget) so concurrent retries arriving at the
      // claim path immediately see the completed row instead of racing the
      // partner into a duplicate send.
      try {
        await this.db.apiIdempotencyKey.update({
          where: {
            teamId_apiKeyId_key: { teamId, apiKeyId, key: idempotencyKey },
          },
          data: {
            responseBody: result as unknown as Prisma.InputJsonValue,
            responseStatus: 200,
            expiresAt: new Date(Date.now() + COMPLETED_TTL_MS),
          },
        });
      } catch (err) {
        // The row should always exist here (we just claimed it). If it's
        // gone the sweeper got aggressive; log + continue so the partner
        // still gets their successful response. A subsequent retry will
        // re-send because the cache is missing — acceptable tail case.
        this.logger.warn(
          `idempotency-key completion failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    return result;
  }

  // ===========================================================================
  // CONTACT-KEYED CONVERSATION ACTIONS (mirror respond.io's n8n surface)
  // ===========================================================================

  /**
   * Find the contact's most-recent conversation. Returns null when the
   * contact has none (e.g. brand-new manual contact that hasn't received a
   * message yet). Caller decides whether to 404 or auto-create.
   */
  private async resolveContactConversation(
    teamId: string,
    contactId: string,
  ): Promise<{ id: string } | null> {
    const conversation = await this.db.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    return conversation;
  }

  /** Resolve `contact: { id } | { phone }` to a contactId. Throws 404 on miss. */
  private async resolveContactIdentifier(
    teamId: string,
    contact: { id: string } | { phone: string },
  ): Promise<string> {
    if ("id" in contact) {
      const row = await this.db.contact.findFirst({
        where: { id: contact.id, teamId },
        select: { id: true },
      });
      if (!row) throw new NotFoundException({ error: "contact not found" });
      return row.id;
    }
    const phone = normalizePhoneE164(contact.phone);
    if (!phone) {
      throw new BadRequestException({
        error: "invalid_phone",
        detail: "phone must be a valid international number (e.g. +1 555 555 0100)",
      });
    }
    const row = await this.db.contact.findFirst({
      where: { teamId, phoneNumber: phone },
      select: { id: true },
    });
    if (!row) throw new NotFoundException({ error: "contact not found" });
    return row.id;
  }

  async assignByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactAssignInput,
  ) {
    const contactRow = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact not found" });
    const conv = await this.resolveContactConversation(teamId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet — start one with POST /v1/messages first",
      });
    }
    await this.assign(teamId, apiKeyId, conv.id, { assignedUserId: input.assignedUserId });
    return { conversationId: conv.id };
  }

  async setStatusByContact(
    teamId: string,
    apiKeyId: string,
    contactId: string,
    input: ExternalContactStatusInput,
  ) {
    const contactRow = await this.db.contact.findFirst({
      where: { id: contactId, teamId },
      select: { id: true },
    });
    if (!contactRow) throw new NotFoundException({ error: "contact not found" });
    const conv = await this.resolveContactConversation(teamId, contactId);
    if (!conv) {
      throw new NotFoundException({
        error: "no_conversation_for_contact",
        detail: "this contact has no conversations yet",
      });
    }
    await this.setStatus(teamId, apiKeyId, conv.id, { status: input.status });
    return { conversationId: conv.id };
  }

  // ===========================================================================
  // TOP-LEVEL POST /v1/messages — n8n-shaped send
  // ===========================================================================

  async sendTopLevelMessage(
    teamId: string,
    apiKeyId: string,
    input: ExternalTopLevelSendMessageInput,
    idempotencyKey?: string,
  ): Promise<{ ok: true; message: ExternalMessage }> {
    if (input.media) {
      throw new BadRequestException({
        error: "media_not_yet_supported",
        detail:
          "URL-based media send via /v1/messages is not yet wired. Use the existing " +
          "media-send paths via the inbox UI for now; the URL → upload → send pipeline " +
          "is on the roadmap.",
      });
    }

    const contactId = await this.resolveContactIdentifier(teamId, input.contact);

    // Find an active (non-closed) conversation or create one. Mirrors the
    // inbound-ingest "one-contact-one-conversation" invariant — if the most
    // recent conversation is closed, we reopen it via the existing
    // conversation-status path so the audit trail captures the reopen.
    let conv = await this.db.conversation.findFirst({
      where: { teamId, contactId },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, status: true },
    });
    if (!conv) {
      const created = await this.db.conversation.create({
        data: {
          teamId,
          contactId,
          status: "pending",
          lastMessageAt: new Date(),
          lastMessagePreview: "",
        },
        select: { id: true, status: true },
      });
      conv = created;
    } else if (conv.status === "closed") {
      // Reopen via setStatus so the audit + analytics counters fire correctly.
      await this.setStatus(teamId, apiKeyId, conv.id, { status: "pending" });
    }

    // ---- Template send ---------------------------------------------------
    //
    // Templates DON'T need the 24h customer-service window — that's their
    // whole point (cold outbound + re-engagement).
    if (input.template) {
      const template = await this.db.messageTemplate.findFirst({
        where: { teamId, name: input.template.name, language: input.template.language },
        select: { id: true },
      });
      if (!template) {
        throw new NotFoundException({
          error: "template_not_found",
          detail: `template "${input.template.name}" (${input.template.language}) not in this team's catalog`,
        });
      }

      try {
        const result = await sendTemplateInternal({
          teamId,
          conversationId: conv.id,
          templateId: template.id,
          variables: input.template.variables,
          senderUserId: null,
          senderApiKeyId: apiKeyId,
          sentVia: `api/external/v1/messages/template/${apiKeyId}`,
        });
        const message = await this.db.message.findUniqueOrThrow({
          where: { id: result.messageId },
        });
        return { ok: true, message: toExternalMessage(message) };
      } catch (err) {
        if (err instanceof SendTemplateValidationError) {
          throw new BadRequestException({
            error: err.code,
            ...(err.detail ? { detail: err.detail } : {}),
          });
        }
        const normalized = normalizeMetaSendError(err);
        if (normalized) {
          throw new UnprocessableEntityException({
            error: normalized.code,
            message: normalized.message,
            detail: normalized.detail,
          });
        }
        throw err;
      }
    }

    // ---- Text send (default) ---------------------------------------------
    if (!input.text) {
      throw new BadRequestException({ error: "text required" });
    }

    const result = await this.sendMessage(
      teamId,
      apiKeyId,
      conv.id,
      {
        body: input.text,
        ...(input.reply_to_message_id ? { replyToMessageId: input.reply_to_message_id } : {}),
      },
      idempotencyKey,
    );
    return { ok: true, message: result.message };
  }

  // ===========================================================================
  // NOTES
  // ===========================================================================

  async createNote(
    teamId: string,
    conversationId: string,
    input: ExternalNoteInput,
  ) {
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    if (!input.authorUserId) {
      throw new BadRequestException({
        error: "authorUserId_required",
        detail:
          "Notes created via /v1 must specify `authorUserId` (a member of " +
          "the team). Create a dedicated service-account user for your " +
          "integration if no human author applies.",
      });
    }
    const u = await this.db.user.findFirst({
      where: { id: input.authorUserId, teamId },
      select: { id: true },
    });
    if (!u) {
      throw new BadRequestException({
        error: "authorUserId is not a member of this team",
      });
    }
    const authorUserId: string = u.id;

    const note = await this.db.internalNote.create({
      data: { conversationId, authorUserId, body: input.body },
    });

    const notePayload = {
      id: note.id,
      conversationId,
      authorUserId,
      body: input.body,
      timestamp: note.timestamp.toISOString(),
    };

    await this.bus.publish({
      type: "note.created",
      teamId,
      conversationId,
      note: notePayload,
    });

    return { note: notePayload };
  }
}
