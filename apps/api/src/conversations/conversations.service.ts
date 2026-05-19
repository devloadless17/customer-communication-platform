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
    opts: {
      take?: number;
      cursor?: string | null;
      search?: string;
      /** Preset (`all`/`mine`/`unassigned`/`closed`) or `stage:<id>`. */
      filter?: "all" | "mine" | "unassigned" | "closed";
      stageId?: string;
    },
  ) {
    // Translate the flat query-string surface into the typed filter union
    // the query layer expects. `stageId` wins over the preset filter when
    // both are sent (the inbox sub-sidebar only sends one at a time).
    const filter = opts.stageId
      ? { kind: "stage" as const, stageId: opts.stageId }
      : opts.filter
        ? { kind: "preset" as const, id: opts.filter }
        : undefined;
    return listConversations(teamId, {
      take: opts.take,
      cursor: opts.cursor,
      search: opts.search,
      viewerUserId,
      ...(filter ? { filter } : {}),
    });
  }

  /**
   * Team-wide preset + per-stage counts for the inbox sub-sidebar.
   *
   * The inbox list ships a paginated slice (CONVERSATIONS_PAGE = 25 by
   * default). Sidebar counts derived from that slice silently under-count
   * once the team has more than one page of conversations — "Mine: 3"
   * when the agent actually has 14, etc. Computing the counts here, scoped
   * to the team and the viewer, fixes the badge truthfulness without
   * forcing the list to load every conversation.
   *
   * Five queries fan out in parallel; the per-stage one walks the
   * non-closed conversations selecting only `contact.stageId` so the
   * grouping happens in JS. At pilot scale (sub-thousand conversations)
   * this is sub-millisecond against the (teamId, status, lastMessageAt)
   * + (teamId, assignedUserId) indexes. Past ~10k conversations the
   * findMany walk dominates and we'd want a raw GROUP BY through Contact.
   */
  async counts(
    teamId: string,
    viewerUserId: string,
  ): Promise<{
    all: number;
    mine: number;
    unassigned: number;
    closed: number;
    byStage: Record<string, number>;
  }> {
    const [all, mine, unassigned, closed, stageRows] = await Promise.all([
      this.db.conversation.count({
        where: { teamId, status: { not: "closed" } },
      }),
      this.db.conversation.count({
        where: { teamId, status: { not: "closed" }, assignedUserId: viewerUserId },
      }),
      this.db.conversation.count({
        where: { teamId, status: { not: "closed" }, assignedUserId: null },
      }),
      this.db.conversation.count({
        where: { teamId, status: "closed" },
      }),
      this.db.conversation.findMany({
        where: { teamId, status: { not: "closed" } },
        select: { contact: { select: { stageId: true } } },
      }),
    ]);

    const byStage: Record<string, number> = {};
    for (const r of stageRows) {
      const sid = r.contact?.stageId;
      if (!sid) continue;
      byStage[sid] = (byStage[sid] ?? 0) + 1;
    }

    return { all, mine, unassigned, closed, byStage };
  }

  /**
   * Hydrate one conversation for the workspace cache-miss path
   * (/api/inbox/conversation/:id). Returns the same `ConversationWithRefs`
   * shape the SSR page uses, so the client can drop the response straight
   * into its in-memory Map and render without a route navigation. Returns
   * null if the conversation isn't in the team's scope.
   */
  getInboxConversation(teamId: string, conversationId: string, viewerUserId: string) {
    return getConversationWithRefs(teamId, conversationId, { viewerUserId });
  }

  /** Older or newer page. Exactly one of `before` / `after` must be set. */
  async listMessages(
    teamId: string,
    conversationId: string,
    opts: {
      before?: string | null;
      after?: string | null;
      take?: number;
      viewerUserId?: string;
    },
  ) {
    if (opts.after) {
      return listNewerMessages(teamId, conversationId, {
        after: opts.after,
        take: opts.take,
        // Threaded so the reconnect state-resync also returns fresh
        // per-agent unreadForMe alongside team-wide unreadCount.
        ...(opts.viewerUserId ? { viewerUserId: opts.viewerUserId } : {}),
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
   * Mark a conversation as unread for the team. Inverse of markRead: bumps
   * `unreadCount` from 0 → 1 so the conversation list re-surfaces the row
   * with an unread badge even though every existing inbound has technically
   * been seen. Does NOT touch the per-agent ConversationReadReceipt — those
   * already correctly reflect when each agent last opened the thread; this
   * is a team-level "needs another look" signal, mirroring WhatsApp Web's
   * Mark as unread right-click action.
   *
   * No-op when unreadCount is already > 0 (real unread already exists).
   * Doesn't call Meta — there's no "mark unread" in the Cloud API; the
   * customer's blue tick stays as-is.
   */
  async markUnread(teamId: string, conversationId: string): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true, unreadCount: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });
    if (conversation.unreadCount > 0) return;

    // CAS so a concurrent inbound that already bumped the counter doesn't
    // get clobbered back down.
    await this.db.conversation.updateMany({
      where: { id: conversationId, teamId, unreadCount: 0 },
      data: { unreadCount: 1 },
    });
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
