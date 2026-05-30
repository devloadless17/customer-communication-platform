import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

// (BadRequestException already imported above — used by listMessages cursor guard.)

import { Prisma } from "@prisma/client";

import { blobStorage } from "@/lib/blob-storage";
import { getProviderBinding } from "@/lib/providers";
import { resolveContactChannel } from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Channel } from "@ccp/shared/types";
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
} from "@/lib/conversations/mutations";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import { runWithConcurrency } from "../common/concurrency";
import type {
  AssignConversationInput,
  BulkDeleteConversationsInput,
  SetConversationStatusInput,
  StartConversationInput,
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
      /** Preset (`active`/`all`/`mine`/`unassigned`/`closed`) or `stage:<id>`. */
      filter?: "active" | "all" | "mine" | "unassigned" | "closed";
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
    active: number;
    all: number;
    mine: number;
    unassigned: number;
    closed: number;
    byStage: Record<string, number>;
  }> {
    const [active, all, mine, unassigned, closed, stageGroups] = await Promise.all([
      this.db.conversation.count({
        where: { teamId, status: { not: "closed" } },
      }),
      this.db.conversation.count({
        where: { teamId },
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
        // deletedAt:null so the inbox stage badge agrees with the settings/
        // stages count (StagesService.counts filters deletedAt:null) and the
        // listConversations stage filter (also deletedAt:null below). Stages
        // are a contact-directory concept — a tombstoned contact shouldn't
        // inflate the badge.
        where: {
          teamId,
          stageId: { not: null },
          deletedAt: null,
          conversations: { some: {} },
        },
        _count: true,
      }),
    ]);

    const byStage: Record<string, number> = {};
    for (const g of stageGroups) {
      if (g.stageId) byStage[g.stageId] = g._count;
    }

    return { active, all, mine, unassigned, closed, byStage };
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

  globalSearchContacts(
    teamId: string,
    opts: { query: string; take?: number; cursor?: string },
  ) {
    return searchContacts(teamId, opts);
  }

  globalSearchMessages(
    teamId: string,
    opts: { query: string; take?: number; cursor?: string },
  ) {
    return searchAllMessages(teamId, opts);
  }

  globalSearchNotes(
    teamId: string,
    opts: { query: string; take?: number; cursor?: string },
  ) {
    return searchAllNotes(teamId, opts);
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
    opts?: { silent?: boolean },
  ): Promise<void> {
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
    // `deletedAt: null` — every other contact-lookup path filters tombstoned
    // rows (contacts list, search, audience groups). Without it here, a
    // soft-deleted contact's id would still spawn a conversation, surfacing
    // a "deleted" person in the inbox. By-id lookups elsewhere (e.g.
    // assignee resolution, sender attribution on historical messages) keep
    // tombstoned rows on purpose so threads remain intact, but starting a
    // NEW thread to a deleted contact has no defensible UX.
    const contact = await this.db.contact.findFirst({
      where: { id: input.contactId, teamId, deletedAt: null },
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
