import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

// (BadRequestException already imported above — used by listMessages cursor guard.)

import { blobStorage } from "@/lib/blob-storage";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  getConversationWithRefs,
  listConversations,
  listNewerMessages,
  listOlderMessages,
  loadMessageContextWindow,
  searchConversationMessages,
} from "@/lib/queries";
import type { User } from "@ccp/shared/types";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type {
  AssignConversationInput,
  BulkDeleteConversationsInput,
  SetConversationStatusInput,
} from "./conversations.schemas";

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  // ---- Reads ----------------------------------------------------------

  list(
    teamId: string,
    viewerUserId: string,
    opts: { take?: number; cursor?: string | null; search?: string },
  ) {
    return listConversations(teamId, { ...opts, viewerUserId });
  }

  /**
   * Hydrate one conversation for the workspace cache-miss path
   * (/api/inbox/conversation/:id). Returns the same `ConversationWithRefs`
   * shape the SSR page uses, so the client can drop the response straight
   * into its in-memory Map and render without a route navigation. Returns
   * null if the conversation isn't in the team's scope.
   */
  getInboxConversation(teamId: string, conversationId: string) {
    return getConversationWithRefs(teamId, conversationId);
  }

  /** Older or newer page. Exactly one of `before` / `after` must be set. */
  async listMessages(
    teamId: string,
    conversationId: string,
    opts: { before?: string | null; after?: string | null; take?: number },
  ) {
    if (opts.after) {
      return listNewerMessages(teamId, conversationId, {
        after: opts.after,
        take: opts.take,
      });
    }
    if (!opts.before) {
      throw new BadRequestException({ error: "before or after cursor required" });
    }
    return listOlderMessages(teamId, conversationId, {
      take: opts.take,
      before: opts.before,
    });
  }

  /** Centered slice of messages for "jump to search hit" UX. */
  async messageContext(
    teamId: string,
    conversationId: string,
    opts: { messageId: string; before?: number; after?: number },
  ) {
    const window = await loadMessageContextWindow(teamId, conversationId, {
      targetMessageId: opts.messageId,
      before: opts.before,
      after: opts.after,
    });
    if (!window) throw new NotFoundException({ error: "not found" });
    return window;
  }

  searchMessages(
    teamId: string,
    conversationId: string,
    opts: { query: string; take?: number; cursor?: string },
  ) {
    return searchConversationMessages(teamId, conversationId, opts);
  }

  // ---- Bulk -----------------------------------------------------------

  /**
   * Bulk delete. Cascades wipe message + note rows; blob keys gathered first,
   * best-effort deleted post-commit. Publishes one `conversation.deleted`
   * per id so the socket fanout splices each row from live clients' lists.
   */
  async bulkDelete(
    teamId: string,
    userId: string,
    input: BulkDeleteConversationsInput,
  ): Promise<{ count: number }> {
    const owned = await this.db.conversation.findMany({
      where: { teamId, id: { in: input.conversationIds } },
      select: {
        id: true,
        messages: {
          where: { mediaKey: { not: null } },
          select: { mediaKey: true },
        },
      },
    });
    if (owned.length === 0) {
      throw new NotFoundException({ error: "no matching conversations in this team" });
    }
    const ownedIds = owned.map((c) => c.id);
    const mediaKeys = owned
      .flatMap((c) => c.messages)
      .map((m) => m.mediaKey)
      .filter((k): k is string => Boolean(k));

    await this.db.conversation.deleteMany({
      where: { teamId, id: { in: ownedIds } },
    });

    if (mediaKeys.length > 0) {
      await blobStorage.delete(mediaKeys);
    }

    // Independent subscriber chains per id, fan in parallel. Socket fanout
    // for 500 ids is microseconds.
    await Promise.all(
      ownedIds.map((cid) =>
        this.bus.publish({
          type: "conversation.deleted",
          teamId,
          conversationId: cid,
          deletedByUserId: userId,
        }),
      ),
    );

    return { count: ownedIds.length };
  }

  /**
   * Assign / unassign a conversation. CAS on the previous assignee — racing
   * clients get 409 and re-render. Publishes `conversation.assigned`
   * so socket-fanout, audit, analytics, and workflow-dispatch all react.
   */
  async assign(
    teamId: string,
    actorUserId: string,
    conversationId: string,
    input: AssignConversationInput,
  ): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        assignedUserId: true,
        contact: { include: { tags: { select: { id: true } } } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const previousAssignedUserId = conversation.assignedUserId;
    const { assignedUserId } = input;

    if (assignedUserId !== null) {
      // Reject deactivated assignees — a soft-deleted agent shouldn't be
      // assigned new work even if their User row still exists for history.
      const member = await this.db.user.findFirst({
        where: { id: assignedUserId, teamId, deactivatedAt: null },
        select: { id: true },
      });
      if (!member) throw new BadRequestException({ error: "user not in team" });
    }

    let updated;
    try {
      updated = await this.db.conversation.update({
        where: {
          id: conversationId,
          teamId,
          assignedUserId: previousAssignedUserId,
        },
        data: { assignedUserId },
        include: { assignedUser: true },
      });
    } catch (err) {
      if (isP2025(err)) {
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
      newAssignedUserId: assignedUserId,
      changedByUserId: actorUserId,
      contact: workflowContactSnapshot(conversation.contact),
    });
  }

  /**
   * Open / pending / closed. CAS on previous status to defeat concurrent
   * flips. Publishes `conversation.status_changed`.
   */
  async setStatus(
    teamId: string,
    actorUserId: string,
    conversationId: string,
    input: SetConversationStatusInput,
  ): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      include: { contact: { include: { tags: { select: { id: true } } } } },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    const previousStatus = conversation.status;

    try {
      await this.db.conversation.update({
        where: { id: conversationId, teamId, status: previousStatus },
        data: { status: input.status },
      });
    } catch (err) {
      if (isP2025(err)) {
        throw new ConflictException({ error: "conversation status changed by someone else" });
      }
      throw err;
    }

    await this.bus.publish({
      type: "conversation.status_changed",
      teamId,
      conversationId,
      previousStatus,
      newStatus: input.status,
      changedByUserId: actorUserId,
      contact: workflowContactSnapshot(conversation.contact),
    });
  }

  /**
   * Hard-delete the conversation. Schema cascades through Message +
   * InternalNote rows; blob keys are collected first + best-effort
   * deleted post-commit. Meta-side messages stay delivered (no Meta unsend
   * API). Contact row is preserved.
   */
  async remove(teamId: string, actorUserId: string, conversationId: string): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        messages: {
          where: { mediaKey: { not: null } },
          select: { mediaKey: true },
        },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const mediaKeys = conversation.messages
      .map((m) => m.mediaKey)
      .filter((k): k is string => Boolean(k));

    await this.db.conversation.delete({ where: { id: conversationId } });

    if (mediaKeys.length > 0) {
      await blobStorage.delete(mediaKeys);
    }

    await this.bus.publish({
      type: "conversation.deleted",
      teamId,
      conversationId,
      deletedByUserId: actorUserId,
    });
  }

  /**
   * Mark conversation read: per-user receipt upsert + team-wide unread
   * counter CAS-zero + Meta read receipt (best-effort). The CAS protects
   * against the read-vs-incoming-bump race; loser skips the publish and
   * the next message:received re-syncs the badge.
   */
  async markRead(teamId: string, userId: string, conversationId: string): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true, unreadCount: true, lastMessageAt: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // Per-agent receipt (idempotent upsert). Sidebar's per-me badge reads
    // against this row, not the team-wide counter.
    await this.db.conversationReadReceipt.upsert({
      where: { userId_conversationId: { userId, conversationId } },
      create: { userId, conversationId, lastReadAt: conversation.lastMessageAt },
      update: { lastReadAt: conversation.lastMessageAt },
    });

    // Always look up the latest inbound — a teammate may have local-marked
    // without notifying Meta. Skip only when there's no inbound at all.
    const latestInbound = await this.db.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: { externalId: true, provider: true },
    });

    if (conversation.unreadCount > 0) {
      const result = await this.db.conversation.updateMany({
        where: { id: conversationId, teamId, unreadCount: conversation.unreadCount },
        data: { unreadCount: 0 },
      });
      if (result.count > 0) {
        await this.bus.publish({
          type: "conversation.read",
          teamId,
          conversationId,
          readByUserId: userId,
        });
      }
    }

    if (latestInbound && latestInbound.provider === "meta_cloud") {
      void this.markIncomingReadBestEffort(teamId, latestInbound.externalId);
    }
  }

  /**
   * Forward a "typing" indicator to Meta. Meta piggybacks the indicator on
   * the read-receipt endpoint: marks the latest inbound as read AND shows
   * the customer a typing bubble for up to 25s. No "stop typing" exists.
   * Silent no-op when there's no inbound to anchor on.
   */
  async sendTyping(
    teamId: string,
    conversationId: string,
  ): Promise<{ ok: true; skipped?: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const latestInbound = await this.db.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: { externalId: true, provider: true },
    });
    if (!latestInbound || latestInbound.provider !== "meta_cloud") {
      return { ok: true, skipped: "no-inbound" };
    }

    try {
      const config = await getMetaSendConfig(teamId);
      await getMetaProvider().sendTypingIndicator?.(latestInbound.externalId, config);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        return { ok: true, skipped: "provider-not-configured" };
      }
      this.logger.warn(`typing send failed: ${err instanceof Error ? err.message : err}`);
    }
    return { ok: true };
  }

  private async markIncomingReadBestEffort(teamId: string, externalId: string): Promise<void> {
    try {
      const config = await getMetaSendConfig(teamId);
      await getMetaProvider().markIncomingRead?.(externalId, config);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return;
      this.logger.warn(`markIncomingRead failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function isP2025(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2025"
  );
}
