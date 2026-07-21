import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

// (BadRequestException already imported above — used by listMessages cursor guard.)

import { Prisma } from "@prisma/client";

import {
  visibilityScopeKey,
  visibilityWhere,
  type ConversationViewer,
} from "@/lib/conversations/visibility";
import { blobStorage } from "@/lib/blob-storage";
import { getProviderBinding } from "@/lib/providers";
import { resolveContactChannel } from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import { normalizePhoneE164 } from "@ccp/shared/utils/phone";
import type { Channel } from "@ccp/shared/types";
import { ContactsService } from "../contacts/contacts.service";
import {
  getConversationWithRefs,
  listConversationAttachments,
  listConversations,
  listNewerMessages,
  listOlderMessages,
  listConversationEvents,
  loadMessageContextWindow,
  searchAllMessages,
  searchAllNotes,
  searchContacts,
  searchConversationMessages,
} from "@/lib/queries";
import {
  assignConversation,
  setConversationStatus,
  setConversationAiEnabled,
} from "@/lib/conversations/mutations";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import { runWithConcurrency } from "../common/concurrency";
import type {
  AssignConversationInput,
  BulkDeleteConversationsInput,
  SetConversationAiEnabledInput,
  SetConversationStatusInput,
  StartConversationInput,
} from "./conversations.schemas";

/** The team-wide half of `counts()` — identical for every agent on the team. */
interface TeamCountsBlock {
  active: number;
  all: number;
  unassigned: number;
  closed: number;
  flagged: number;
  stageGroups: Array<{ stageId: string | null; _count: number }>;
  uActive: number;
  uAll: number;
  uUnassigned: number;
  uClosed: number;
  uFlagged: number;
}

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly contacts: ContactsService,
  ) {}

  // ---- Reads ----------------------------------------------------------

  list(
    teamId: string,
    viewerUserId: string,
    opts: {
      /** The signed-in viewer, for the agent-visibility boundary. Optional so
       *  server-to-server callers (which are never restricted) can omit it. */
      viewer?: ConversationViewer;
      take?: number;
      cursor?: string | null;
      search?: string;
      /** Preset (`active`/`all`/`mine`/`unassigned`/`closed`/`flagged`) or `stage:<id>`. */
      filter?: "active" | "all" | "mine" | "unassigned" | "closed" | "flagged";
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
      // Restricts an agent to their own conversations when the org asked for
      // it; `{}` (a no-op) for everyone else.
      ...(opts.viewer ? { visibility: visibilityWhere(opts.viewer) } : {}),
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
   * Eleven queries fan out in parallel: 5 status/preset totals, 5 unread-filtered
   * (`unreadCount > 0`) variants, and 1 per-stage groupBy. The total/preset counts
   * hit the (teamId, status, lastMessageAt) + (teamId, assignedUserId) indexes;
   * the 5 unread counts narrow on those same indexes and are served by the
   * hand-written PARTIAL index `Conversation_teamId_unread_idx`
   * (`Conversation(teamId) WHERE unreadCount > 0`, migration
   * 20260615130000) — tiny, because zero-unread rows dominate. (This comment
   * used to say no index covered `unreadCount`; that was true when written and
   * stale from the moment the partial index shipped. It has since sent at
   * least one audit chasing a "missing index" that already existed — a bare
   * EXPLAIN on a small dev table shows a Seq Scan either way, so confirm with
   * `SET enable_seqscan=off` before believing it.) A FULL unreadCount index is
   * still the wrong answer: it would bloat every markRead write.
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
    viewer?: ConversationViewer,
  ): Promise<{
    active: number;
    all: number;
    mine: number;
    unassigned: number;
    closed: number;
    flagged: number;
    byStage: Record<string, number>;
    unread: {
      active: number;
      all: number;
      mine: number;
      unassigned: number;
      closed: number;
      flagged: number;
    };
  }> {
    // Per-bucket UNREAD = conversations with unreadCount>0 in that bucket. Same
    // bucket predicates as the totals, AND unreadCount>0. Drives the green
    // unread pills on the sub-sidebar filters. Coalesced client-side so the
    // extra counts don't fire on every inbound; indexed on (teamId,status).
    const unreadWhere: Prisma.ConversationWhereInput = { unreadCount: { gt: 0 } };

    // NINE of the eleven queries are TEAM-WIDE — identical for every agent on
    // the team — and only `mine` / `unread.mine` depend on the viewer. This
    // endpoint re-fires on every count-changing socket event, so a single
    // inbound message made all 40 agents of a busy tenant each run the full
    // eleven: ~440 counts for one message, 360 of them computing the same nine
    // numbers. The team block is therefore memoized briefly and SHARED across
    // agents, while the two viewer-scoped counts always run fresh.
    //
    // Note where the win actually comes from: the SHARED IN-FLIGHT PROMISE,
    // not the TTL. One inbound event makes every agent refetch at once, so
    // collapsing that simultaneous burst to a single round of queries costs
    // exactly zero staleness. The TTL is deliberately tiny (250ms) — just wide
    // enough to also catch refetches spread by client-side debounce jitter,
    // narrow enough that nobody perceives it. A multi-second TTL was the first
    // instinct and it is wrong here: the sidebar count must move the moment
    // YOU close or assign a thread, and CLAUDE.md holds the inbox to
    // "everything feels instant". `mine` is never memoized at all.
    const team = await this.teamCounts(teamId, unreadWhere, viewer);
    const [mine, uMine] = await Promise.all([
      this.db.conversation.count({
        where: { teamId, status: { not: "closed" }, assignedUserId: viewerUserId },
      }),
      this.db.conversation.count({
        where: {
          teamId,
          status: { not: "closed" },
          assignedUserId: viewerUserId,
          ...unreadWhere,
        },
      }),
    ]);
    const {
      active, all, unassigned, closed, flagged, stageGroups,
      uActive, uAll, uUnassigned, uClosed, uFlagged,
    } = team;
    return this.shapeCounts({
      active, all, mine, unassigned, closed, flagged, stageGroups,
      uActive, uAll, uMine, uUnassigned, uClosed, uFlagged,
    });
  }

  /** Cached team-wide half of `counts()`. See the note there. */
  private static readonly COUNTS_TTL_MS = 250;
  private readonly teamCountsCache = new Map<
    string,
    { at: number; value: TeamCountsBlock }
  >();
  private readonly teamCountsInFlight = new Map<string, Promise<TeamCountsBlock>>();

  private async teamCounts(
    teamId: string,
    unreadWhere: Prisma.ConversationWhereInput,
    viewer?: ConversationViewer,
  ): Promise<TeamCountsBlock> {
    const scope = viewer ? visibilityWhere(viewer) : {};
    // The memo key MUST include the scope. Keyed by teamId alone, a restricted
    // agent would read another agent's cached totals — a leak no WHERE clause
    // could catch, because the query never runs. Unrestricted viewers all share
    // the "team" key, so the cache stays exactly as effective as before.
    const key = `${teamId}::${viewer ? visibilityScopeKey(viewer) : "team"}`;
    const hit = this.teamCountsCache.get(key);
    if (hit && Date.now() - hit.at < ConversationsService.COUNTS_TTL_MS) return hit.value;
    const inFlight = this.teamCountsInFlight.get(key);
    // Share the in-flight promise so a burst — which is exactly what a single
    // inbound event produces across N agents — collapses to ONE round of
    // queries instead of N.
    if (inFlight) return inFlight;

    const p = this.loadTeamCounts(teamId, unreadWhere, scope)
      .then((value) => {
        this.teamCountsCache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => {
        this.teamCountsInFlight.delete(key);
      });
    this.teamCountsInFlight.set(key, p);
    return p;
  }

  private async loadTeamCounts(
    teamId: string,
    unreadWhere: Prisma.ConversationWhereInput,
    scope: { assignedUserId?: string } = {},
  ): Promise<TeamCountsBlock> {
    const [
      active,
      all,
      unassigned,
      closed,
      flagged,
      stageGroups,
      uActive,
      uAll,
      uUnassigned,
      uClosed,
      uFlagged,
    ] = await Promise.all([
      this.db.conversation.count({
        where: { teamId, ...scope, status: { not: "closed" } },
      }),
      this.db.conversation.count({
        where: { teamId, ...scope },
      }),
      this.db.conversation.count({
        // AND, not a sibling spread: `assignedUserId: null` would otherwise
        // overwrite the scope's `assignedUserId` (last-wins) and report the
        // TEAM-wide unassigned count to a restricted agent. Under AND the two
        // are contradictory, which is the correct answer — a restricted agent
        // has no unassigned conversations by definition.
        where: {
          teamId,
          AND: [scope, { status: { not: "closed" }, assignedUserId: null }],
        },
      }),
      this.db.conversation.count({
        where: { teamId, ...scope, status: "closed" },
      }),
      // Threads with at least one unresolved triage flag. Rides the partial
      // index Conversation_teamId_openFlag_idx, which spans only flagged rows —
      // so this count reads a tiny index, not the team's conversation
      // partition. Deliberately NOT status-narrowed: an unresolved complaint on
      // a closed thread still needs triage (matches the list filter).
      this.db.conversation.count({
        where: { teamId, ...scope, openFlagCount: { gt: 0 } },
      }),
      this.db.contact.groupBy({
        by: ["stageId"],
        // deletedAt:null so the inbox stage badge agrees with the settings/
        // stages count (StagesService.counts filters deletedAt:null) and the
        // listConversations stage filter (also deletedAt:null below). Stages
        // are a contact-directory concept — a tombstoned contact shouldn't
        // inflate the badge.
        // Stage badge: a restricted agent counts only stages of contacts whose
        // conversation is theirs, so the badge agrees with the list they see.
        where: {
          teamId,
          stageId: { not: null },
          deletedAt: null,
          conversations: { some: scope },
        },
        _count: true,
      }),
      this.db.conversation.count({
        where: { teamId, ...scope, status: { not: "closed" }, ...unreadWhere },
      }),
      this.db.conversation.count({
        where: { teamId, ...scope, ...unreadWhere },
      }),
      this.db.conversation.count({
        where: {
          teamId,
          AND: [
            scope,
            { status: { not: "closed" }, assignedUserId: null, ...unreadWhere },
          ],
        },
      }),
      this.db.conversation.count({
        where: { teamId, ...scope, status: "closed", ...unreadWhere },
      }),
      this.db.conversation.count({
        where: { teamId, ...scope, openFlagCount: { gt: 0 }, ...unreadWhere },
      }),
    ]);
    return {
      active, all, unassigned, closed, flagged, stageGroups,
      uActive, uAll, uUnassigned, uClosed, uFlagged,
    };
  }

  /** Fold the team block + the two viewer counts into the wire shape. */
  private shapeCounts(c: {
    active: number;
    all: number;
    mine: number;
    unassigned: number;
    closed: number;
    flagged: number;
    stageGroups: Array<{ stageId: string | null; _count: number }>;
    uActive: number;
    uAll: number;
    uMine: number;
    uUnassigned: number;
    uClosed: number;
    uFlagged: number;
  }) {
    const byStage: Record<string, number> = {};
    for (const g of c.stageGroups) {
      if (g.stageId) byStage[g.stageId] = g._count;
    }

    return {
      active: c.active,
      all: c.all,
      mine: c.mine,
      unassigned: c.unassigned,
      closed: c.closed,
      flagged: c.flagged,
      byStage,
      unread: {
        active: c.uActive,
        all: c.uAll,
        mine: c.uMine,
        unassigned: c.uUnassigned,
        closed: c.uClosed,
        flagged: c.uFlagged,
      },
    };
  }

  /**
   * Team-wide total of UNREAD messages across non-closed conversations — the
   * single number behind the AppRail Inbox badge. Sums the per-conversation
   * `unreadCount` (unread is team-wide; see CLAUDE.md "unread is team-wide").
   * Closed threads are excluded: a handled conversation shouldn't keep the nav
   * badge lit. One indexed aggregate; refetched client-side (debounced) on
   * message:new / conversation:read / conversation:status.
   */
  async unreadTotal(
    teamId: string,
    viewer?: ConversationViewer,
  ): Promise<{ unread: number }> {
    const agg = await this.db.conversation.aggregate({
      _sum: { unreadCount: true },
      // Scoped: the AppRail badge must count what this viewer can actually
      // open, or a restricted agent sees a number they can never clear.
      where: {
        teamId,
        ...(viewer ? visibilityWhere(viewer) : {}),
        status: { not: "closed" },
      },
    });
    return { unread: agg._sum.unreadCount ?? 0 };
  }

  /**
   * Hydrate one conversation for the workspace cache-miss path
   * (/api/inbox/conversation/:id). Returns the same `ConversationWithRefs`
   * shape the SSR page uses, so the client can drop the response straight
   * into its in-memory Map and render without a route navigation. Returns
   * null if the conversation isn't in the team's scope.
   */
  getInboxConversation(
    teamId: string,
    conversationId: string,
    viewer?: ConversationViewer,
  ) {
    // A restricted agent gets null → the controller's 404. This is the single
    // richest payload in the product (full thread, notes, activity, contact
    // PII), so it is scoped at the query rather than after the fact.
    return getConversationWithRefs(teamId, conversationId, {
      ...(viewer ? { visibility: visibilityWhere(viewer) } : {}),
    });
  }

  /** Older or newer page. Exactly one of `before` / `after` must be set. */
  async listMessages(
    teamId: string,
    conversationId: string,
    opts: {
      before?: string | null;
      after?: string | null;
      /** Tail row id paired with `after` — enables the strict-tuple delta. */
      afterId?: string | null;
      take?: number;
    },
  ) {
    if (opts.after) {
      return listNewerMessages(teamId, conversationId, {
        after: opts.after,
        afterId: opts.afterId ?? undefined,
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

  /** Recent activity-log events for one thread — the events-only refetch the
   *  live thread fires after an audit-implying frame lands. */
  listEvents(teamId: string, conversationId: string) {
    return listConversationEvents(teamId, conversationId);
  }

  /** "Files" tab in the contact panel — keyset-paginated, kind-filtered. */
  listAttachments(
    teamId: string,
    conversationId: string,
    opts: { cursor?: string; take?: number; kind?: string },
  ) {
    return listConversationAttachments(teamId, conversationId, opts);
  }

  // ---- Global (team-wide) search — the tabbed inbox search bar -----------
  //
  // "Team-wide" is now viewer-relative: for a restricted agent these return
  // only their own conversations' messages, notes and contacts. This is the
  // widest read surface in the product, so the boundary is applied at the
  // query, not by filtering results afterwards.

  globalSearchContacts(
    teamId: string,
    opts: { query: string; take?: number; cursor?: string },
    viewer?: ConversationViewer,
  ) {
    return searchContacts(teamId, {
      ...opts,
      ...(viewer ? { visibility: visibilityWhere(viewer) } : {}),
    });
  }

  globalSearchMessages(
    teamId: string,
    opts: { query: string; take?: number; cursor?: string },
    viewer?: ConversationViewer,
  ) {
    return searchAllMessages(teamId, {
      ...opts,
      ...(viewer ? { visibility: visibilityWhere(viewer) } : {}),
    });
  }

  globalSearchNotes(
    teamId: string,
    opts: { query: string; take?: number; cursor?: string },
    viewer?: ConversationViewer,
  ) {
    return searchAllNotes(teamId, {
      ...opts,
      ...(viewer ? { visibility: visibilityWhere(viewer) } : {}),
    });
  }

  // ---- Bulk -----------------------------------------------------------

  /**
   * Bulk delete. Cascades wipe message + note rows; blob keys gathered first,
   * best-effort deleted post-commit. Publishes one `conversation.deleted`
   * per id so the socket fanout splices each row from live clients' lists.
   */
  /**
   * Every media/thumbnail R2 key belonging to the given conversations, read in
   * bounded pages.
   *
   * Both delete paths used to pull these through a nested `messages` include
   * with no `take`. The bulk path caps at 500 conversations
   * (`BulkDeleteConversationsSchema`), so one call materialized every
   * media-bearing message across 500 threads into a single Prisma result — for
   * a large tenant, millions of rows on the V8 heap at once. That is an OOM
   * against the api container's 2GB limit, which takes the whole process and
   * every agent's socket with it. The single-conversation path had the same
   * shape with a smaller radius (one long-lived enterprise thread).
   *
   * Keyset paging does the same total work with a bounded resident set, so
   * peak memory no longer scales with a tenant's history.
   */
  private async collectMediaKeys(
    teamId: string,
    conversationIds: string[],
  ): Promise<string[]> {
    const keys: string[] = [];
    const PAGE = 1_000;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.message.findMany({
        where: {
          teamId,
          conversationId: { in: conversationIds },
          OR: [{ mediaKey: { not: null } }, { mediaThumbnailKey: { not: null } }],
        },
        select: { id: true, mediaKey: true, mediaThumbnailKey: true },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const m of page) {
        if (m.mediaKey) keys.push(m.mediaKey);
        if (m.mediaThumbnailKey) keys.push(m.mediaThumbnailKey);
      }
      if (page.length < PAGE) break;
      cursor = page[page.length - 1]?.id;
      if (!cursor) break;
    }
    return keys;
  }

  async bulkDelete(
    teamId: string,
    userId: string,
    input: BulkDeleteConversationsInput,
  ): Promise<{ count: number }> {
    const owned = await this.db.conversation.findMany({
      where: { teamId, id: { in: input.conversationIds } },
      select: { id: true },
    });
    if (owned.length === 0) {
      throw new NotFoundException({ error: "no matching conversations in this team" });
    }
    const ownedIds = owned.map((c) => c.id);

    const mediaKeys = await this.collectMediaKeys(teamId, ownedIds);

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
   * **Status side-effect** — the canonical rule lives in
   * `lib/conversations/mutations.ts:assignConversation` (this method only
   * delegates); the client predictor `features/inbox/lib/predict-status.ts`
   * mirrors it. **Assignment NEVER sets `open` — only the assignee chatting
   * does (claim-on-reply).** Applied atomically with the assignment write (one
   * CAS update pinning both columns) so the two never desync:
   *
   *   - Assign to a user + status was `closed`  →  becomes `pending` (reopen into triage)
   *   - Unassign (→ null) + status was `open`   →  becomes `pending` (back to triage)
   *   - Assign to a user + status was `pending`/`open`  →  status unchanged
   *   - All other combinations                          →  status unchanged
   *
   * The side-effect is keyed on STATUS, not on whether the assignee changed:
   * re-assigning the SAME already-assigned user while the chat is `closed`
   * still reopens it to `pending`. In that case only
   * `conversation.status_changed` fires — `conversation.assigned` is gated on
   * an actual assignee change, so on-assignment workflows don't re-run.
   *
   * Both transitions are single-step (`closed → pending`, `open → pending`), so
   * no auto-cascade guard is needed. When status DOES change, a second
   * `conversation.status_changed` event is published with the same actor, so
   * audit log, analytics, workflow triggers, and the realtime sidebar reflect
   * both changes. (There is no bulk-assign endpoint today; if one is added it
   * should decide deliberately whether to carry this per-row side-effect.)
   */
  async assign(
    teamId: string,
    actorUserId: string,
    conversationId: string,
    input: AssignConversationInput,
    opts?: { silent?: boolean; canAssignOthers?: boolean },
  ): Promise<void> {
    // AUTHORIZATION. Claiming work is always allowed; putting work on someone
    // ELSE's plate is the supervisor action, gated by
    // `conversations:assignOthers` (admin/manager by default). Enforced here
    // rather than as a route decorator because the answer depends on the BODY
    // — "assign to me" and "assign to Sara" hit the same endpoint.
    //
    // Unassigning is treated as a reassignment of someone else's work when the
    // thread isn't yours: taking a conversation off a teammate and dropping it
    // back in the queue is the same power, so it needs the same capability.
    if (opts?.canAssignOthers !== true) {
      const target = input.assignedUserId;
      if (target !== null && target !== actorUserId) {
        throw new ForbiddenException({ error: "cannot_assign_others" });
      }
      if (target === null) {
        const current = await this.db.conversation.findFirst({
          where: { id: conversationId, teamId },
          select: { assignedUserId: true },
        });
        if (current?.assignedUserId && current.assignedUserId !== actorUserId) {
          throw new ForbiddenException({ error: "cannot_unassign_others" });
        }
      }
    }

    // Business rule (status-flip, CAS, event publishing) lives in the shared
    // lib helper so the workflow `assign_to` step and the /v1 API run the
    // EXACT same logic — see lib/conversations/mutations.ts. This method only
    // maps the typed outcome to the HTTP error surface.
    const result = await assignConversation({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      targetUserId: input.assignedUserId,
      changedByUserId: actorUserId,
      silent: opts?.silent === true,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({ error: "conversation not found" });
      }
      if (result.reason === "invalid_user") {
        throw new BadRequestException({ error: "user not in team" });
      }
      throw new ConflictException({
        error: "conversation was reassigned by someone else",
      });
    }
  }

  /**
   * Open / pending / closed. CAS on previous status to defeat concurrent
   * flips. Publishes `conversation.status_changed`.
   *
   * `opts.silent` lets an internal/code caller mark THIS status change as a
   * cascaded/internal mutation — the published event carries `silent: true`,
   * so the workflow-dispatch and outbound-webhook subscribers skip it (no
   * "on status changed" workflow re-trigger, no webhook echo). Use it when
   * your code flips status as a side-effect and a listening workflow would
   * otherwise loop. Default false — the human-UI route never passes it, so
   * agent clicks behave exactly as before. Socket UI + audit still fire.
   * See ConversationAssignedEvent.silent.
   */
  async setStatus(
    teamId: string,
    actorUserId: string,
    conversationId: string,
    input: SetConversationStatusInput,
    opts?: { silent?: boolean },
  ): Promise<void> {
    // Unassign-on-close + CAS + event publishing live in the shared lib helper
    // so the workflow `close_conversation` step and /v1 run identically — see
    // lib/conversations/mutations.ts. This method maps the outcome to HTTP.
    const result = await setConversationStatus({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      status: input.status,
      changedByUserId: actorUserId,
      silent: opts?.silent === true,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({ error: "conversation not found" });
      }
      throw new ConflictException({
        error: "conversation status changed by someone else",
      });
    }
  }

  /**
   * Toggle AI Autopilot for a conversation (inbox "Pause AI" / "Resume AI").
   * CAS + event publishing live in the shared lib helper so the /v1 self-pause
   * and the auto-pause-on-human-reply run identically.
   */
  async setAiEnabled(
    teamId: string,
    actorUserId: string,
    conversationId: string,
    input: SetConversationAiEnabledInput,
  ): Promise<void> {
    const result = await setConversationAiEnabled({
      db: this.db,
      publish: (e) => this.bus.publish(e),
      teamId,
      conversationId,
      aiEnabled: input.aiEnabled,
      changedByUserId: actorUserId,
    });
    if (!result.ok) {
      if (result.reason === "not_found") {
        throw new NotFoundException({ error: "conversation not found" });
      }
      throw new ConflictException({
        error: "conversation ai setting changed by someone else",
      });
    }
  }

  /**
   * Hard-delete the conversation. Schema cascades through Message +
   * InternalNote rows; blob keys are collected first + best-effort
   * deleted post-commit. Meta-side messages stay delivered (no Meta unsend
   * API). Contact row is preserved.
   */
  /**
   * Get-or-create the (single) conversation for a contact, returning its id so
   * the caller can open it in the inbox. This is the "re-chat with a customer"
   * entry point: a hard-deleted conversation leaves the Contact intact but with
   * no thread, so without this there's no way back into a chat with them.
   *
   * Honors the one-conversation-per-contact invariant (@@unique[teamId,
   * contactId]):
   *   - existing OPEN/PENDING thread → returned as-is (created:false).
   *   - existing CLOSED thread → reopened to pending via setStatus (so the
   *     audit + analytics + workflow reopen side-effects fire), reopened:true.
   *   - no thread → created `pending` with the channel stamped from the
   *     contact's identity, created:true. P2002 (lost the race to a concurrent
   *     inbound/forward) reuses the winner.
   *
   * A freshly-created thread is EMPTY (no message). It surfaces in the opening
   * agent's inbox via the `?c=<id>` SSR path (the page renders it as the active
   * thread). We deliberately do NOT publish a "conversation created" socket
   * frame here: an empty, never-messaged thread doesn't need to appear in every
   * teammate's list — it joins all lists the moment the first message flows
   * (the send paths' `message.sent` carries `newConversation`). Note the 24h
   * window is closed on a brand-new thread, so the reply box correctly offers
   * templates only until the customer replies — Meta's rule, surfaced by the
   * existing composer.
   */
  async startConversation(
    teamId: string,
    actorUserId: string,
    input: StartConversationInput,
  ): Promise<{ conversationId: string; created: boolean; reopened: boolean }> {
    // Resolve the target contact id — either given directly, or found/created
    // from a phone number (the shared-contact card's "Message" action passes a
    // number, not an id). Find-or-create keeps it a single atomic call and
    // reuses the canonical ContactsService.create (stage seeding, soft-delete
    // revive, contact.created event) instead of a fragile client dance.
    let contactId = input.contactId ?? null;
    if (!contactId) {
      const phone = normalizePhoneE164(input.phone ?? "");
      if (!phone) {
        throw new BadRequestException({
          error: "a valid contactId or phone number is required",
        });
      }
      const active = await this.db.contact.findFirst({
        where: { teamId, phoneNumber: phone, deletedAt: null },
        select: { id: true },
      });
      if (active) {
        contactId = active.id;
      } else {
        try {
          contactId = (
            await this.contacts.create(teamId, actorUserId, {
              phoneNumber: phone,
              ...(input.name ? { name: input.name } : {}),
            })
          ).id;
        } catch (err) {
          // A concurrent "Message" click for the same number won the create
          // (phone is @@unique). Don't surface its 409 — re-find and reuse the
          // winner's contact, mirroring the conversation-create P2002 rescue.
          const isDuplicate =
            err instanceof ConflictException ||
            (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002");
          if (!isDuplicate) throw err;
          const winner = await this.db.contact.findFirst({
            where: { teamId, phoneNumber: phone, deletedAt: null },
            select: { id: true },
          });
          if (!winner) throw err;
          contactId = winner.id;
        }
      }
    }

    // `deletedAt: null` — every other contact-lookup path filters tombstoned
    // rows (contacts list, search, audience groups). Without it here, a
    // soft-deleted contact's id would still spawn a conversation, surfacing
    // a "deleted" person in the inbox. By-id lookups elsewhere (e.g.
    // assignee resolution, sender attribution on historical messages) keep
    // tombstoned rows on purpose so threads remain intact, but starting a
    // NEW thread to a deleted contact has no defensible UX.
    const contact = await this.db.contact.findFirst({
      where: { id: contactId, teamId, deletedAt: null },
      select: { id: true, phoneNumber: true, identityChannel: true, externalContactId: true },
    });
    if (!contact) throw new NotFoundException({ error: "contact not found" });

    const existing = await this.db.conversation.findFirst({
      where: { teamId, contactId: contact.id },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true, status: true },
    });

    if (existing) {
      if (existing.status === "closed") {
        // Reopen through setStatus so the reopen is audited + fans out exactly
        // like any other status change (and clears nothing it shouldn't).
        await this.setStatus(teamId, actorUserId, existing.id, { status: "pending" });
        return { conversationId: existing.id, created: false, reopened: true };
      }
      return { conversationId: existing.id, created: false, reopened: false };
    }

    // Stamp channel from the contact's identity — source of truth at creation
    // (contacts are siloed + immutable-identity). A wrong default would
    // propagate to every Message.channel on this thread. No reachable address
    // → keep whatsapp; the first send surfaces the proper error.
    let channel: Channel = "whatsapp";
    try {
      channel = resolveContactChannel(contact).channel;
    } catch {
      /* keep default */
    }

    try {
      const created = await this.db.conversation.create({
        data: {
          teamId,
          contactId: contact.id,
          channel,
          status: "pending",
          lastMessagePreview: "",
        },
        select: { id: true },
      });
      return { conversationId: created.id, created: true, reopened: false };
    } catch (err) {
      // Lost the race for this contact's single conversation to a concurrent
      // inbound/forward — reuse the winner (just created `pending`, no reopen).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await this.db.conversation.findFirstOrThrow({
          where: { teamId, contactId: contact.id },
          orderBy: { lastMessageAt: "desc" },
          select: { id: true },
        });
        return { conversationId: winner.id, created: false, reopened: false };
      }
      throw err;
    }
  }

  async remove(teamId: string, actorUserId: string, conversationId: string): Promise<void> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true },
    });
    if (!conversation) throw new NotFoundException({ error: "conversation not found" });

    const mediaKeys = await this.collectMediaKeys(teamId, [conversationId]);

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
    // Single-round-trip CAS. The client calls markRead on EVERY visible
    // thread mount (not just when its cached snapshot claims unread>0) so
    // the team-wide counter converges to server truth even when that
    // snapshot was stale-low — see use-conversation-events. The common case
    // is therefore "already read"; the previous shape paid a read + CAS for
    // it. Now: one conditional updateMany whose WHERE doubles as the gate.
    // `result.count === 0` means EITHER already-read OR conversation
    // missing — the 404 case is rare (UI doesn't navigate to vanished
    // conversations); a follow-up cheap PK probe only fires for that
    // ambiguous branch so the 99% case is one round-trip.
    //
    // Mirrors the markReadOnAgentSend helper at messages.service.ts:200-211
    // (the 2026-05-26 P1 batch's markRead-1-RTT fix); was previously
    // applied there but missed this call site.
    const result = await this.db.conversation.updateMany({
      where: { id: conversationId, teamId, unreadCount: { gt: 0 } },
      data: { unreadCount: 0 },
    });
    if (result.count === 0) {
      // Either already-read OR missing. Probe to distinguish so callers
      // still see 404 when the conversation truly vanished.
      const exists = await this.db.conversation.findFirst({
        where: { id: conversationId, teamId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException({ error: "conversation not found" });
      return; // already-read fast path
    }
    await this.bus.publish({
      type: "conversation.read",
      teamId,
      conversationId,
      readByUserId: userId,
    });

    // Meta read receipt (best-effort) — only when there was unread to clear.
    // A CAS that lost (a concurrent inbound bumped the counter between the
    // read and the update) still sends it: the agent IS looking, so mark
    // the latest inbound read on Meta regardless of who won the counter
    // race.
    const latestInbound = await this.db.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: {
        externalId: true,
        channel: true,
        // The customer's identity — social channels mark the thread seen by
        // recipient id (PSID / IGSID); WhatsApp ignores it. Loaded off the same
        // query so no extra round-trip on the read hot path.
        conversation: {
          select: { contact: { select: { externalContactId: true, phoneNumber: true } } },
        },
      },
    });
    if (latestInbound) {
      const recipientId =
        latestInbound.conversation.contact.externalContactId ??
        latestInbound.conversation.contact.phoneNumber ??
        undefined;
      void this.markIncomingReadBestEffort(
        teamId,
        latestInbound.externalId,
        latestInbound.channel,
        recipientId,
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
    active: boolean = true,
  ): Promise<{ ok: true; skipped?: string }> {
    const conversation = await this.db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: {
        id: true,
        // Recipient identity for the social typing sender_action (PSID / IGSID);
        // WhatsApp ignores it and anchors on the inbound message id.
        contact: { select: { externalContactId: true, phoneNumber: true } },
      },
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
      const recipientId =
        conversation.contact.externalContactId ??
        conversation.contact.phoneNumber ??
        undefined;
      await binding.provider.sendTypingIndicator?.(
        latestInbound.externalId,
        config,
        recipientId,
        active,
      );
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
    recipientId?: string,
  ): Promise<void> {
    try {
      const binding = getProviderBinding(channel);
      const config = await binding.getSendConfig(teamId);
      await binding.provider.markIncomingRead?.(externalId, config, recipientId);
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) return;
      this.logger.warn(`markIncomingRead failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
