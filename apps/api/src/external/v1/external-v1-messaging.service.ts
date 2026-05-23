import { createHash } from "node:crypto";

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
  conversationRowToExternal,
  toExternalMessage,
  EXTERNAL_CONVERSATION_INCLUDE,
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
import { getProviderBinding } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import type { Message, Channel, User } from "@ccp/shared/types";
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

// Idempotency claim sentinels — shared by every /v1 send path so the text and
// template flows can't drift. `responseStatus: 0` marks a pending claim; a
// crashed handler's pending row is GC'd after PENDING_TTL by the sweeper at
// lib/sweepers/api-idempotency-cleanup. Completed rows live COMPLETED_TTL.
const IDEMPOTENCY_PENDING_STATUS = 0;
const IDEMPOTENCY_PENDING_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60_000;

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
  // IDEMPOTENCY (shared by text + template /v1 send paths)
  // ===========================================================================

  /**
   * CLAIM-then-execute idempotency on the (teamId, apiKeyId, key) unique index.
   *
   * Returns:
   *   - { kind: "claimed" }      → caller OWNS a pending sentinel row and MUST
   *                                resolve it (`completeIdempotency` on success,
   *                                `releaseIdempotency` on failure) before
   *                                returning. Proceed with the real work.
   *   - { kind: "replay", result } → a prior identical request already
   *                                completed; return it verbatim (zero side
   *                                effects, API-key token refunded).
   *
   * Throws ConflictException(409) when a concurrent request with the same key
   * is still in flight. Centralizing this is what closes the template
   * double-send gap (audit 2026-05-22): previously only the text path had it.
   */
  private async claimIdempotency<T>(
    teamId: string,
    apiKeyId: string,
    key: string,
    /** SHA-256 of the canonical request — see requestFingerprint(). On a
     *  completed-row replay we reject if it differs from the stored one
     *  (same key, different payload), instead of silently returning the prior
     *  response and dropping the new send. */
    requestHash: string,
  ): Promise<{ kind: "claimed" } | { kind: "replay"; result: T }> {
    const claimPending = () =>
      this.db.apiIdempotencyKey.create({
        data: {
          teamId,
          apiKeyId,
          key,
          requestHash,
          responseBody: { _pending: true } as Prisma.InputJsonValue,
          responseStatus: IDEMPOTENCY_PENDING_STATUS,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_PENDING_TTL_MS),
        },
      });
    try {
      await claimPending();
      return { kind: "claimed" };
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      ) {
        throw err;
      }
      // Another request already claimed this key. Read its state.
      const cached = await this.db.apiIdempotencyKey.findUnique({
        where: { teamId_apiKeyId_key: { teamId, apiKeyId, key } },
        select: { responseBody: true, responseStatus: true, expiresAt: true, requestHash: true },
      });
      if (!cached) {
        // Vanished between P2002 and the read (sweeper / manual delete).
        throw new ConflictException({
          error: "idempotency_in_progress",
          detail: "Concurrent retry race — try again in a moment.",
        });
      }
      if (cached.responseStatus === IDEMPOTENCY_PENDING_STATUS) {
        if (cached.expiresAt > new Date()) {
          throw new ConflictException({
            error: "idempotency_in_progress",
            detail:
              "A previous request with this Idempotency-Key is still in flight. " +
              "Retry in a few seconds.",
          });
        }
        // Stale pending past TTL — clear and tell the partner to re-claim.
        await this.db.apiIdempotencyKey.deleteMany({
          where: { teamId, apiKeyId, key },
        });
        throw new ConflictException({
          error: "idempotency_in_progress",
          detail: "Stale pending claim cleared — retry.",
        });
      }
      if (cached.expiresAt > new Date()) {
        // Same key reused for a DIFFERENT request — reject (Stripe-style 422)
        // rather than returning the prior response, which would silently drop
        // the new send. Legacy rows have a null requestHash → skip the check
        // and replay as before.
        if (cached.requestHash && cached.requestHash !== requestHash) {
          throw new UnprocessableEntityException({
            error: "idempotency_key_reuse",
            detail:
              "This Idempotency-Key was already used with a different request payload. " +
              "Use a fresh key per distinct request.",
          });
        }
        // Completed + still fresh — replay. Refund the API-key token: the
        // request did zero real work, so it shouldn't burn quota.
        refundApiKeyBucket(apiKeyId);
        return { kind: "replay", result: cached.responseBody as unknown as T };
      }
      // Expired completed row — delete + re-claim, then proceed.
      await this.db.apiIdempotencyKey.deleteMany({ where: { teamId, apiKeyId, key } });
      await claimPending();
      return { kind: "claimed" };
    }
  }

  /** Flip a claimed pending row to the completed response (24h TTL). */
  private async completeIdempotency<T>(
    teamId: string,
    apiKeyId: string,
    key: string,
    result: T,
  ): Promise<void> {
    try {
      await this.db.apiIdempotencyKey.update({
        where: { teamId_apiKeyId_key: { teamId, apiKeyId, key } },
        data: {
          responseBody: result as unknown as Prisma.InputJsonValue,
          responseStatus: 200,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_COMPLETED_TTL_MS),
        },
      });
    } catch (err) {
      // Row should exist (we just claimed it). If the sweeper got aggressive,
      // log + continue so the partner still gets their success response.
      this.logger.warn(
        `idempotency-key completion failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Release a claimed pending row on failure so a retry can re-claim fresh. */
  private async releaseIdempotency(
    teamId: string,
    apiKeyId: string,
    key: string,
  ): Promise<void> {
    await this.db.apiIdempotencyKey
      .deleteMany({
        where: { teamId, apiKeyId, key, responseStatus: IDEMPOTENCY_PENDING_STATUS },
      })
      .catch(() => {
        /* best-effort */
      });
  }

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
      include: EXTERNAL_CONVERSATION_INCLUDE,
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(conversationRowToExternal);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  async getConversation(teamId: string, id: string) {
    const row = await this.db.conversation.findFirst({
      where: { id, teamId },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    if (!row) throw new NotFoundException({ error: "conversation not found" });
    // `conversation.contact` is embedded; the top-level `contact` is kept as a
    // convenience alias so the single-conversation response still surfaces it
    // at the root for callers that read response.contact directly.
    const conversation = conversationRowToExternal(row);
    return { conversation, contact: conversation.contact };
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
    // The existence check doubles as the conversation context we return
    // alongside the messages, so a page of messages always tells the caller
    // who the thread is with (contact + assignee embedded) without a separate
    // GET /v1/conversations/:id.
    const conv = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: EXTERNAL_CONVERSATION_INCLUDE,
    });
    if (!conv) throw new NotFoundException({ error: "conversation not found" });

    const rows = await this.db.message.findMany({
      where: { conversationId },
      // toExternalMessage reads scalar + media columns only; rawPayload
      // (Meta JSONB, 5-20KB/row) would ship to the integrator on every page.
      omit: { rawPayload: true },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalMessage);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { conversation: conversationRowToExternal(conv), items, nextCursor };
  }

  async findMessage(teamId: string, id: string) {
    const row = await this.db.message.findFirst({
      where: { id, teamId },
      omit: { rawPayload: true },
      // Embed the parent conversation (which itself embeds contact + assignee)
      // so a single message fetch carries who it's with — no follow-up call.
      include: { conversation: { include: EXTERNAL_CONVERSATION_INCLUDE } },
    });
    if (!row) throw new NotFoundException({ error: "message not found" });
    return {
      message: toExternalMessage(row),
      conversation: conversationRowToExternal(row.conversation),
    };
  }

  async sendMessage(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    /** Optional idempotency key from the `Idempotency-Key` request header. */
    idempotencyKey?: string,
  ) {
    // Idempotency — CLAIM-then-execute via the shared `claimIdempotency`
    // helper (also used by the template path so the two can't drift). A
    // replay returns the prior response with zero side effects; a fresh
    // claim means we own the pending row and MUST resolve it below
    // (releaseIdempotency on any failure, completeIdempotency on success).
    if (idempotencyKey) {
      const claim = await this.claimIdempotency<{ message: ExternalMessage }>(
        teamId,
        apiKeyId,
        idempotencyKey,
        requestFingerprint("send_message", {
          conversationId,
          body: input.body,
          replyToMessageId: input.replyToMessageId ?? null,
        }),
      );
      if (claim.kind === "replay") return claim.result;
    }

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        contactId: true,
        // Channel is conversation-owned — bind + stamp from here.
        channel: true,
        contact: {
          select: {
            phoneNumber: true,
            identityChannel: true,
            externalContactId: true,
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
    const provider = conversation.channel;
    const binding = getProviderBinding(provider);

    // Free-form send window — driven by the provider capability; `null` skips
    // it (channel with no window restriction).
    const windowMs = binding.provider.capabilities.freeFormWindowMs;
    if (windowMs !== null) {
      const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
      const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
      if (win.state === "closed" || win.state === "never") {
        throw new UnprocessableEntityException({
          error: "outside_24h_window",
          detail:
            "free-form messages are only allowed within 24h of the contact's last inbound. " +
            "use a pre-approved template for cold outbound (not yet exposed via the external API).",
          lastInboundAt,
        });
      }
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
          await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
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
      const config = await binding.getSendConfig(teamId);
      send = await binding.provider.sendText(
        {
          to: channel.to,
          body: input.body,
          ...(replyToExternalId ? { replyToExternalId } : {}),
        },
        config,
      );
    } catch (err) {
      // Send failed — release the idempotency claim so the partner can
      // retry. Without this, the row stays in `pending` state for the full
      // PENDING_TTL and every retry inside that window gets 409.
      if (idempotencyKey) {
        await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
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
      channel: provider,
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
      channel: provider,
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId },
      timestamp: send.timestamp.toISOString(),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };

    await this.bus.publish({
      type: "message.sent",
      teamId,
      conversationId,
      contactId: conversation.contactId,
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

    // Complete the claim — flip the pending sentinel to the real response.
    // AWAITED (not fire-and-forget) so concurrent retries arriving at the
    // claim path immediately see the completed row instead of racing the
    // partner into a duplicate send.
    if (idempotencyKey) {
      await this.completeIdempotency(teamId, apiKeyId, idempotencyKey, result);
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
      // Stamp the new thread's channel from the contact's identity — the
      // source of truth at creation (contacts are siloed + immutable-identity).
      // Load-bearing now that the send paths stamp Message.channel FROM the
      // conversation: a wrong @default(meta_cloud) here would propagate to
      // every message on a future non-phone contact's thread.
      const contactChannel = await this.db.contact.findUnique({
        where: { id: contactId },
        select: { phoneNumber: true, identityChannel: true, externalContactId: true },
      });
      let channel: Channel = "whatsapp";
      if (contactChannel) {
        try {
          channel = resolveContactChannel(contactChannel).channel;
        } catch {
          // No reachable address — keep the default; the downstream send will
          // surface the proper "contact has no reachable address" error.
        }
      }
      try {
        conv = await this.db.conversation.create({
          data: {
            teamId,
            contactId,
            channel,
            status: "pending",
            lastMessageAt: new Date(),
            lastMessagePreview: "",
          },
          select: { id: true, status: true },
        });
      } catch (err) {
        // Lost the race for this contact's single conversation (unique
        // [teamId, contactId]) to a concurrent inbound/forward — reuse the
        // winner's row (it was just created `pending`, so no reopen needed).
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          conv = await this.db.conversation.findFirstOrThrow({
            where: { teamId, contactId },
            orderBy: { lastMessageAt: "desc" },
            select: { id: true, status: true },
          });
        } else throw err;
      }
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

      // Idempotency — same claim-then-execute as the text path (shared
      // helpers). Templates are billed cold-outbound, so a partner retry
      // double-send is the most expensive duplicate; this closes the gap
      // where the template branch ignored the Idempotency-Key entirely
      // (audit 2026-05-22). Claimed AFTER the template lookup so a bad
      // template name doesn't strand a pending row.
      if (idempotencyKey) {
        const claim = await this.claimIdempotency<{ ok: true; message: ExternalMessage }>(
          teamId,
          apiKeyId,
          idempotencyKey,
          requestFingerprint("send_template", {
            contact: input.contact,
            template: input.template,
          }),
        );
        if (claim.kind === "replay") return claim.result;
      }

      let out: { ok: true; message: ExternalMessage };
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
        out = { ok: true, message: toExternalMessage(message) };
      } catch (err) {
        if (err instanceof SendTemplateValidationError) {
          // Pre-delivery validation failure — nothing was sent. Release the
          // claim so a corrected retry can re-claim fresh.
          if (idempotencyKey) {
            await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
          }
          throw new BadRequestException({
            error: err.code,
            ...(err.detail ? { detail: err.detail } : {}),
          });
        }
        const normalized = normalizeMetaSendError(err);
        if (normalized) {
          // Meta rejected — nothing delivered. Release so a retry can re-claim.
          if (idempotencyKey) {
            await this.releaseIdempotency(teamId, apiKeyId, idempotencyKey);
          }
          throw new UnprocessableEntityException({
            error: normalized.code,
            message: normalized.message,
            detail: normalized.detail,
          });
        }
        // Unknown / ambiguous error that may have landed AFTER Meta accepted
        // the send — do NOT release. Leave the pending claim so a retry gets
        // 409 rather than risking a duplicate billed template send. Mirrors
        // the text path, which never releases once past the Meta call.
        throw err;
      }
      if (idempotencyKey) {
        await this.completeIdempotency(teamId, apiKeyId, idempotencyKey, out);
      }
      return out;
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
      data: { teamId, conversationId, authorUserId, body: input.body },
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

/**
 * Canonical request fingerprint for idempotency-key reuse detection. `payload`
 * is the already-Zod-parsed input (stable key order for a given route), so a
 * plain JSON.stringify is deterministic — two identical requests hash equal,
 * two different payloads under the same key hash differently. The `route`
 * prefix keeps a text send and a template send under the same key distinct.
 */
function requestFingerprint(route: string, payload: unknown): string {
  return createHash("sha256")
    .update(`${route}\n${JSON.stringify(payload)}`)
    .digest("hex");
}
