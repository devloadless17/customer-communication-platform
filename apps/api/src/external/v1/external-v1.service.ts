import { Prisma } from "@prisma/client";
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import {
  toExternalContact,
  toExternalConversation,
  toExternalMessage,
  type ExternalMessage,
} from "@/lib/external-shapes";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import type { Message, User } from "@ccp/shared/types";
import { computeWindowStatus } from "@ccp/shared/utils/window";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../../events/event-bus.module";
import { DbService } from "../../db/db.service";
import type {
  ExternalAssignInput,
  ExternalNoteInput,
  ExternalSendMessageInput,
  ExternalStatusInput,
  ListConversationsQueryInput,
  ListMessagesQueryInput,
} from "./external-v1.schemas";

/**
 * External API service. Routes are parallel to the internal ones but
 * scoped by `teamId` from the API key, and `changedByUserId / senderUserId`
 * is always null (the API key is an org-level credential, not a person).
 *
 * Each operation publishes the SAME domain event the internal route does —
 * downstream subscribers (socket fanout, audit, analytics, workflow
 * dispatch, future outbound webhooks) can't tell which entry point fired.
 */
@Injectable()
export class ExternalV1Service {
  private readonly logger = new Logger(ExternalV1Service.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  // ---- Contacts ---------------------------------------------------------

  async getContact(teamId: string, id: string) {
    const row = await this.db.contact.findFirst({ where: { id, teamId } });
    if (!row) throw new NotFoundException({ error: "contact not found" });
    return toExternalContact(row);
  }

  // ---- Conversations ----------------------------------------------------

  async listConversations(teamId: string, q: ListConversationsQueryInput) {
    const rows = await this.db.conversation.findMany({
      where: {
        teamId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.phone ? { contact: { phoneNumber: q.phone } } : {}),
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: q.limit + 1, // peek ahead for nextCursor
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
      include: { contact: true },
    });
    if (!row) throw new NotFoundException({ error: "conversation not found" });
    return {
      conversation: toExternalConversation(row),
      contact: toExternalContact(row.contact),
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
        contact: { include: { tags: { select: { id: true } } } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    if (input.assignedUserId !== null) {
      const member = await this.db.user.findFirst({
        where: { id: input.assignedUserId, teamId },
        select: { id: true },
      });
      if (!member) throw new BadRequestException({ error: "user not in team" });
    }

    const updated = await this.db.conversation.update({
      where: { id: conversationId },
      data: { assignedUserId: input.assignedUserId },
      include: { assignedUser: true },
    });

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
      previousAssignedUserId: conversation.assignedUserId,
      newAssignedUserId: input.assignedUserId,
      // External API: no acting user; the audit row attributes via apiKeyId.
      changedByUserId: null,
      changedByApiKeyId: apiKeyId,
      contact: workflowContactSnapshot(conversation.contact),
    });
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

  // ---- Messages ---------------------------------------------------------

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
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, q.limit).map(toExternalMessage);
    const lastItem = items[items.length - 1];
    const nextCursor = rows.length > q.limit && lastItem ? lastItem.id : null;
    return { items, nextCursor };
  }

  async sendMessage(
    teamId: string,
    apiKeyId: string,
    conversationId: string,
    input: ExternalSendMessageInput,
    /** Optional idempotency key from the `Idempotency-Key` request header. */
    idempotencyKey?: string,
  ) {
    // Idempotency replay — first thing we check, so a retry never reaches
    // Meta. 24h window (Stripe-style) is plenty for a partner's automated
    // retry loop and short enough that a logically-new operation that
    // happens to reuse a key isn't permanently shadowed.
    if (idempotencyKey) {
      const cached = await this.db.apiIdempotencyKey.findUnique({
        where: {
          teamId_apiKeyId_key: { teamId, apiKeyId, key: idempotencyKey },
        },
        select: { responseBody: true, expiresAt: true },
      });
      if (cached && cached.expiresAt > new Date()) {
        return cached.responseBody as unknown as { message: ExternalMessage };
      }
      // Expired or missing → fall through and re-do the work. Expired
      // rows are reaped by the periodic sweeper below.
    }

    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { contact: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // 24h window — surface the constraint before Meta so n8n flows can
    // branch to template-send cleanly. Meta returns 131047 otherwise.
    const lastInbound = await this.db.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });
    const win = computeWindowStatus(lastInbound?.timestamp.toISOString() ?? null);
    if (win.state === "closed" || win.state === "never") {
      throw new UnprocessableEntityException({
        error: "outside_24h_window",
        detail:
          "free-form messages are only allowed within 24h of the contact's last inbound. " +
          "use a pre-approved template for cold outbound (not yet exposed via the external API).",
        lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
      });
    }

    let replyToMessageId: string | null = null;
    let replyToExternalId: string | undefined;
    if (input.replyToMessageId) {
      const replyRow = await this.db.message.findFirst({
        where: { id: input.replyToMessageId, conversationId, teamId },
        select: { id: true, externalId: true },
      });
      if (replyRow) {
        replyToMessageId = replyRow.id;
        if (!replyRow.externalId.startsWith("tmp_")) {
          replyToExternalId = replyRow.externalId;
        }
      }
    }

    if (!conversation.contact.phoneNumber) {
      throw new BadRequestException({
        error: "contact_has_no_phone",
        detail: "This contact has no WhatsApp number.",
      });
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
      if (err instanceof ProviderNotConfiguredError) {
        throw new ConflictException({
          error: "whatsapp_not_connected",
          detail: err.message,
        });
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        // Unified error shape `{ error, detail? }` — same as every other
        // /v1 throw. The Meta http status + raw message folded into
        // `detail` so partners that need the underlying info still get
        // it, but the top-level contract is uniform.
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
      senderUserId: null, // No human author for external API sends.
      body: input.body,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/external/v1", apiKeyId } as Prisma.InputJsonValue,
      timestamp: send.timestamp,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    });

    const preview = input.body.slice(0, 200);
    await this.db.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: send.timestamp, lastMessagePreview: preview },
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
      lastMessageAt: send.timestamp.toISOString(),
      unreadDelta: 0,
      senderUserId: null,
      // Attribution for the audit timeline + any future subscriber that
      // wants to know which API key sent this message.
      senderApiKeyId: apiKeyId,
    });

    const result = { message: toExternalMessage(created) };

    // Persist the idempotency mapping so a retry within 24h replays this
    // exact response. Done last + fire-and-forget so a write failure on the
    // idempotency table doesn't roll back a successful send. A failed write
    // just means a retry would re-send — degrades to current behavior.
    if (idempotencyKey) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      void this.db.apiIdempotencyKey
        .upsert({
          where: {
            teamId_apiKeyId_key: { teamId, apiKeyId, key: idempotencyKey },
          },
          create: {
            teamId,
            apiKeyId,
            key: idempotencyKey,
            responseBody: result as unknown as Prisma.InputJsonValue,
            responseStatus: 200,
            expiresAt,
          },
          update: {
            responseBody: result as unknown as Prisma.InputJsonValue,
            responseStatus: 200,
            expiresAt,
          },
        })
        .catch((err) => {
          this.logger.warn(
            `idempotency-key write failed: ${err instanceof Error ? err.message : err}`,
          );
        });
    }

    return result;
  }

  // ---- Notes ------------------------------------------------------------

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

    // Require authorUserId on the request — the previous silent-fallback
    // to "oldest admin" permanently mislabeled API-created notes to a
    // real human who didn't write them. Better to make the partner be
    // explicit (use a service-account user if needed).
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
