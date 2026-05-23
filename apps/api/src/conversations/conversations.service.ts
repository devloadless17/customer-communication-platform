import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

// (BadRequestException already imported above — used by listMessages cursor guard.)

import { blobStorage } from "@/lib/blob-storage";
import { getProviderBinding } from "@/lib/providers";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Channel } from "@ccp/shared/types";
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
import { runWithConcurrency } from "../common/concurrency";
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
   * Five queries fan out in parallel. The preset counts hit the
   * (teamId, status, lastMessageAt) + (teamId, assignedUserId) indexes.
   * The per-stage count is a server-side GROUP BY through Contact (NOT a
   * full-table walk into JS): one conversation per contact is DB-enforced
   * (@@unique([teamId, contactId])), so counting contacts that have a
   * conversation, grouped by stageId, equals counting conversations by
   * their contact's stage. The aggregate runs on the (teamId, stageId)
   * index and returns one row per stage instead of every conversation row.
   * This endpoint re-fires on every count-changing socket event, so the
   * walk it replaced was on a genuinely hot path.
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
    const [all, mine, unassigned, closed, stageGroups] = await Promise.all([
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
      this.db.contact.groupBy({
        by: ["stageId"],
        where: { teamId, stageId: { not: null }, conversations: { some: {} } },
        _count: true,
      }),
    ]);

    const byStage: Record<string, number> = {};
    for (const g of stageGroups) {
      if (g.stageId) byStage[g.stageId] = g._count;
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
  getInboxConversation(teamId: string, conversationId: string) {
    return getConversationWithRefs(teamId, conversationId);
  }

  /** Older or newer page. Exactly one of `before` / `after` must be set. */
  async listMessages(
    teamId: string,
    conversationId: string,
    opts: {
      before?: string | null;
      after?: string | null;
      take?: number;
    },
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

    // Bounded fanout — 16 lanes. The socket emit itself is microseconds,
    // but the full subscriber chain (audit + analytics + workflow-dispatch
    // + outbound-webhooks + cache-revalidate) runs sequentially per id, so
    // an unbounded Promise.all could push hundreds of ms of work onto the
    // event loop at once on a 500-id delete.
    await runWithConcurrency(ownedIds, 16, async (cid) => {
      await this.bus.publish({
        type: "conversation.deleted",
        teamId,
        conversationId: cid,
        deletedByUserId: userId,
      });
    });

    return { count: ownedIds.length };
  }

  /**
   * Assign / unassign a conversation. CAS on the previous assignee + status
   * — racing clients get 409 and re-render. Publishes `conversation.assigned`
   * (only when the assignee actually changes) so socket-fanout, audit,
   * analytics, and workflow-dispatch all react.
   *
   * **Status side-effect** (product rule, see thread w/ user on 2026-05-20):
   * Assignment carries an ownership signal — closed chats getting picked
   * back up should reopen, and chats that lose their assignee should drop
   * back to "waiting" state. Applied atomically with the assignment write
   * so the two never desync:
   *
   *   - Assign to a user + status was `pending`/`closed`  →  becomes `open`
   *   - Unassign (→ null) + status was `open`             →  becomes `pending`
   *   - All other combinations                            →  status unchanged
   *
   * The side-effect is keyed on STATUS, not on whether the assignee changed:
   * re-assigning the SAME already-assigned user while the chat is `pending`
   * (or `closed`) still promotes it to `open`. In that case only
   * `conversation.status_changed` fires — `conversation.assigned` is gated on
   * an actual assignee change, so on-assignment workflows don't re-run.
   *
   * Both transitions are bounded (`closed → open` and `open → pending` are
   * single-step), so an explicit "after one auto-promote, the next won't
   * cascade" guard isn't needed. When status DOES change, a second event
   * `conversation.status_changed` is published with the same actor — that
   * way audit log, analytics, workflow triggers (e.g. "on reopen, ping
   * channel"), and the realtime sidebar all reflect both changes without
   * needing to special-case auto-promotes.
   *
   * Bulk-assign opts out of the side-effect (see `assignBulk`) — bulk
   * operations should be predictable; auto-reopening 50 closed chats in a
   * batch would be a footgun.
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
        status: true,
        contact: { include: { tags: { select: { id: true } } } },
      },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const previousAssignedUserId = conversation.assignedUserId;
    const previousStatus = conversation.status;
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

    // Derive the next status from the assignment transition. Two narrow
    // rules — anything not listed keeps status untouched.
    //   - Assigning to someone while pending/closed → open (claim moves it
    //     out of the triage column or reopens it).
    //   - Unassigning while open → pending (back to triage).
    let nextStatus: typeof previousStatus = previousStatus;
    if (assignedUserId !== null && previousStatus !== "open") {
      nextStatus = "open";
    } else if (assignedUserId === null && previousStatus === "open") {
      nextStatus = "pending";
    }
    const statusChanged = nextStatus !== previousStatus;

    let updated;
    try {
      updated = await this.db.conversation.update({
        // CAS includes status when we're changing it, so a teammate's
        // racing setStatus call can't get clobbered silently — they get
        // 409 and retry. When status isn't changing we still pin it in
        // the where so a concurrent close (e.g. teammate closes while we
        // assign) isn't dropped by writing back `data.status: <stale>`.
        where: {
          id: conversationId,
          teamId,
          assignedUserId: previousAssignedUserId,
          status: previousStatus,
        },
        data: statusChanged
          ? { assignedUserId, status: nextStatus }
          : { assignedUserId },
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

    // Only when the assignee actually changed — re-picking the SAME user to
    // claim an assigned-but-pending chat (→ open) must not re-trigger
    // on-assignment workflows / audit rows; only the status_changed side-
    // effect below should fire.
    if (assignedUserId !== previousAssignedUserId) {
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

    if (statusChanged) {
      // Fired AFTER conversation.assigned so a consumer that watches both
      // (audit / analytics / workflow-dispatch) sees the cause-then-effect
      // order. Same actor, same contact snapshot — the status change was
      // a side-effect of the assign, not an independent event, but it IS
      // a real status change and downstream handlers should treat it as
      // such (workflows on reopen/pending fire, badge counts re-evaluate,
      // status-history audit row gets written).
      await this.bus.publish({
        type: "conversation.status_changed",
        teamId,
        conversationId,
        previousStatus,
        newStatus: nextStatus,
        changedByUserId: actorUserId,
        contact: workflowContactSnapshot(conversation.contact),
      });
    }
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

    // Compound where (id + teamId) via deleteMany — Prisma's single `delete`
    // accepts only unique constraints, and Conversation.id alone is the
    // unique key, so a bare delete would honor any id matching the just-
    // gated findFirst. The gate ABOVE already enforces tenant ownership,
    // but defense-in-depth: a future refactor that drops the gate (or
    // races a transaction across it) shouldn't be one line away from a
    // cross-tenant delete. deleteMany on (id, teamId) is no-op if either
    // doesn't match.
    const { count } = await this.db.conversation.deleteMany({
      where: { id: conversationId, teamId },
    });
    if (count === 0) {
      // Row vanished between findFirst and deleteMany — concurrent delete
      // by another actor. Treat as already-gone success; no fanout needed.
      return;
    }

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
   * Mark conversation read: team-wide unread counter CAS-zero + Meta read
   * receipt (best-effort). Unread is team-wide only — there is no per-agent
   * read state for the inbox, so any member reading clears it for everyone.
   * The CAS protects against the read-vs-incoming-bump race; loser skips the
   * publish and the next message:received re-syncs the badge.
   */
  async markRead(teamId: string, userId: string, conversationId: string): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true, unreadCount: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    // Fast path: already read. The client now calls markRead on EVERY visible
    // thread mount (not just when its cached snapshot claims unread>0) so the
    // team-wide counter converges to server truth even when that snapshot was
    // stale-low — see use-conversation-events. That makes the "already read"
    // call the common case, so keep it to a single cheap read with NO Meta
    // round-trip: the markRead that originally cleared the counter already sent
    // the read receipt, and re-sending it on every open would spam Meta's API
    // (and burn rate budget) for zero benefit.
    if (conversation.unreadCount <= 0) return;

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

    // Meta read receipt (best-effort) — only when there was unread to clear.
    // A CAS that lost (a concurrent inbound bumped the counter between the read
    // and the update) still sends it: the agent IS looking, so mark the latest
    // inbound read on Meta regardless of who won the counter race.
    const latestInbound = await this.db.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: { externalId: true, channel: true },
    });
    if (latestInbound) {
      void this.markIncomingReadBestEffort(
        teamId,
        latestInbound.externalId,
        latestInbound.channel,
      );
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
      select: { externalId: true, channel: true },
    });
    if (!latestInbound) {
      return { ok: true, skipped: "no-inbound" };
    }

    try {
      // Route by the inbound's own channel; a provider without typing support
      // no-ops via the optional `?.`.
      const binding = getProviderBinding(latestInbound.channel);
      const config = await binding.getSendConfig(teamId);
      await binding.provider.sendTypingIndicator?.(latestInbound.externalId, config);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        return { ok: true, skipped: "provider-not-configured" };
      }
      this.logger.warn(`typing send failed: ${err instanceof Error ? err.message : err}`);
    }
    return { ok: true };
  }

  private async markIncomingReadBestEffort(
    teamId: string,
    externalId: string,
    channel: Channel,
  ): Promise<void> {
    try {
      const binding = getProviderBinding(channel);
      const config = await binding.getSendConfig(teamId);
      await binding.provider.markIncomingRead?.(externalId, config);
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
