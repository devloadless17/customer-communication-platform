import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type {
  Ticket,
  TicketAttachment as TicketAttachmentView,
  TicketCounts,
  TicketEvent,
  TicketThreadMessage,
  TicketFieldDefinition,
  TicketSlaPolicy,
} from "@ccp/shared/tickets/types";
import {
  assertCanViewConversation,
  isRestrictedViewer,
  type ConversationViewer,
} from "@/lib/conversations/visibility";
import {
  addTicketNote,
  createTicket,
  deleteTicket,
  updateTicket,
  type TicketActor,
  type TicketOutcome,
} from "@/lib/tickets/mutations";
import {
  bindGuestConversation,
  getGuestSnapshot,
  revokeTicketShare,
  shareTicket,
} from "@/lib/tickets/shares";
import {
  addTicketAttachment,
  getTicketAttachmentForRead,
  MAX_TICKET_ATTACHMENTS,
  removeTicketAttachment,
} from "@/lib/tickets/attachments";
import { ticketByIdWhere } from "@/lib/tickets/access";
import {
  addTicketMessage,
  getThreadUnreadAnchor,
  listTicketThread,
  markThreadRead,
} from "@/lib/tickets/thread";
import {
  createTicketView,
  deleteTicketView,
  getTicketViewFilters,
  listTicketViews,
  ticketViewToFilters,
  updateTicketView,
} from "@/lib/tickets/views";
import type { Role } from "@ccp/shared/types";
import {
  getTicket,
  getTicketCounts,
  listTicketEvents,
  listTicketNotes,
  listTickets,
  ticketVisibilityWhere,
} from "@/lib/tickets/queries";

import type { ApiSession } from "../auth/session.guard";
import { ConversationsService } from "../conversations/conversations.service";
import { DbService } from "../db/db.service";
import type {
  CreateTicketFieldInput,
  CreateTicketInput,
  CreateTicketViewInput,
  EscalateTicketInput,
  ListTicketsQuery,
  TicketSettingsInput,
  UpdateTicketFieldInput,
  UpdateTicketInput,
  UpdateTicketViewInput,
  UpsertSlaPolicyInput,
} from "./tickets.schemas";

/**
 * One uploaded file, as multer hands it over. `memoryStorage` is correct HERE
 * (unlike the 100 MiB message-media path, which streams to a temp file): ticket
 * attachments are capped small and arrive a few at a time, so the buffer never
 * approaches the per-request ceilings that motivated diskStorage there.
 */
export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

/**
 * Thin seam over lib/tickets — the domain layer owns every rule; this class
 * supplies `this.db`, resolves the `me`/`none` assignee shorthands, applies the
 * agent conversation-visibility boundary, and maps the domain's typed outcomes
 * onto HTTP exceptions.
 *
 * The /v1 external surface calls the SAME lib functions with an apiKey actor,
 * so the two surfaces cannot drift.
 */
@Injectable()
export class TicketsService {
  constructor(
    private readonly db: DbService,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * Agent conversation-visibility, applied to tickets.
   *
   * A restricted agent sees the tickets on THEIR conversations — the boundary
   * follows the thread, not the ticket's own assignee, because a ticket is work
   * on a conversation and the conversation is what the policy scopes. The
   * restriction goes in an AND array, never a sibling spread: a spread lets a
   * later filter object silently overwrite it, which is how this boundary has
   * been defeated before.
   */
  private restriction(viewer?: ConversationViewer) {
    if (!viewer || !isRestrictedViewer(viewer)) return null;
    // Via the canonical TICKET builder (lib/tickets/queries.ts), which wraps
    // the conversation rule from lib/conversations/visibility.ts and adds the
    // unbound-escalation case. Sharing it with `listTickets` is the point: a
    // hand-written fragment here is exactly the copy-drift that let the board
    // and this guard disagree about escalated-in tickets. The null-sentinel +
    // AND-array composition stay unchanged.
    return ticketVisibilityWhere(viewer.userId);
  }

  private async assertVisible(viewer: ConversationViewer | undefined, ticketId: string) {
    const restriction = this.restriction(viewer);
    if (!restriction) return;
    const ok = await this.db.ticket.findFirst({
      // Through the ACCESS gate (mine OR shared with me), then AND the agent
      // visibility restriction. A bare `workspaceId` here 404'd every ticket a
      // guest department had been escalated INTO — the exact shape this gate
      // exists to stop being hand-written.
      where: { AND: [ticketByIdWhere(viewer!.workspaceId, ticketId), restriction] },
      select: { id: true },
    });
    // 404, never 403 — a 403 confirms the row exists to someone not allowed to
    // know that.
    if (!ok) throw new NotFoundException({ error: "ticket_not_found" });
  }

  async list(
    workspaceId: string,
    viewerUserId: string,
    query: ListTicketsQuery,
    viewer?: ConversationViewer,
  ): Promise<{
    tickets: Ticket[];
    nextCursor: { activityAt: string; id: string } | null;
    /** Ids on this page with a thread reply the CALLER hasn't read. Always
     *  empty for an API key — read state is per-user and a key has no user. */
    unreadTicketIds: string[];
  }> {
    // `me` → the caller, `none` → unassigned (an explicit null, which the query
    // layer distinguishes from "don't filter"), anything else → that id.
    const assignedUserId =
      query.assignee === undefined
        ? undefined
        : query.assignee === "me"
          ? viewerUserId
          : query.assignee === "none"
            ? null
            : query.assignee;

    // Same three-way shape as `assignee`: `none` is a real filter ("owned by no
    // team"), distinct from omitting the param entirely.
    const assignedTeamId =
      query.team === undefined ? undefined : query.team === "none" ? null : query.team;

    // The boundary is a FILTER passed into the one query every read goes
    // through — not a branch here. Computing a restriction and then forgetting
    // to apply it is how this control has silently died before.
    const restrictedTo = this.restriction(viewer) ? viewerUserId : undefined;

    // A saved view's criteria go UNDERNEATH the explicit query params: the view
    // is the board you opened, the chips are what you then narrowed by. An
    // unknown/foreign view id contributes nothing rather than 404ing the board
    // (getTicketViewFilters is scoped to what this agent may SEE, so a
    // colleague's personal view id simply resolves to null).
    const viewFilters = query.viewId
      ? await getTicketViewFilters(this.db, workspaceId, viewerUserId, query.viewId)
      : null;

    return listTickets(this.db, workspaceId, {
      ...(viewFilters ? ticketViewToFilters(viewFilters, viewerUserId) : {}),
      ...this.filters(query),
      ...(assignedUserId !== undefined ? { assignedUserId } : {}),
      ...(assignedTeamId !== undefined ? { assignedTeamId } : {}),
      ...(restrictedTo ? { restrictToConversationsAssignedTo: restrictedTo } : {}),
      // Both of these are per-USER, resolved from the session rather than from
      // client input: an API key has no user, so it gets neither the filter nor
      // somebody else's badges.
      ...(query.unread && viewerUserId ? { unreadRepliesFor: viewerUserId } : {}),
      ...(viewerUserId ? { viewerUserId } : {}),
    });
  }

  private filters(query: ListTicketsQuery) {
    return {
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.contactId ? { contactId: query.contactId } : {}),
      ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.accountId ? { accountId: query.accountId } : {}),
      ...(query.tagIds ? { tagIds: query.tagIds } : {}),
      ...(query.breached ? { breachedOnly: true } : {}),
      ...(query.q ? { query: query.q } : {}),
      ...(query.shared ? { sharedWithUsOnly: true } : {}),
      ...(query.untriaged ? { untriagedOnly: true } : {}),
      ...((query.cursorActivityAt ?? query.cursorCreatedAt) && query.cursorId
        ? {
            cursor: {
              activityAt: new Date((query.cursorActivityAt ?? query.cursorCreatedAt) as string),
              id: query.cursorId,
            },
          }
        : {}),
      ...(query.limit ? { limit: query.limit } : {}),
    };
  }

  async counts(
    workspaceId: string,
    viewerUserId: string,
    viewer?: ConversationViewer,
  ): Promise<TicketCounts> {
    return getTicketCounts(
      this.db,
      workspaceId,
      viewerUserId,
      this.restriction(viewer) ? viewerUserId : undefined,
    );
  }

  /**
   * One ticket: the work, the THREAD (the cross-department conversation), the
   * log, and where this reader's "New replies" divider goes. One round-trip —
   * the page renders all of it at once and a second fetch would just add a
   * spinner to the surface people came to read.
   */
  async get(
    workspaceId: string,
    id: string,
    viewer?: ConversationViewer,
    viewerUserId?: string,
  ): Promise<{
    ticket: Ticket;
    events: TicketEvent[];
    thread: TicketThreadMessage[];
    /** THIS workspace's private notes — never another department's. */
    notes: TicketEvent[];
    threadUnreadSinceMessageId: string | null;
  }> {
    await this.assertVisible(viewer, id);
    const ticket = await getTicket(this.db, workspaceId, id);
    if (!ticket) throw new NotFoundException({ error: "ticket_not_found" });
    const [events, thread, notes, anchor] = await Promise.all([
      listTicketEvents(this.db, workspaceId, id),
      listTicketThread(this.db, workspaceId, id),
      listTicketNotes(this.db, workspaceId, id),
      // An API key has no reader, so it never has an unread anchor.
      viewerUserId ? getThreadUnreadAnchor(this.db, id, viewerUserId) : Promise.resolve(null),
    ]);
    return { ticket, events, thread, notes, threadUnreadSinceMessageId: anchor };
  }

  async create(
    workspaceId: string,
    actor: TicketActor,
    body: CreateTicketInput,
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket; openTicketCount: number }> {
    // Same boundary as get/update/addNote, applied to the CONVERSATION the
    // ticket is being raised on: without it a visibility-restricted agent
    // could probe conversation ids and, on a hit, receive the full ticket
    // payload (contact name included) for a thread they must not see.
    if (viewer && isRestrictedViewer(viewer)) {
      try {
        await assertCanViewConversation(this.db, viewer, body.conversationId);
      } catch {
        // 404, never 403 — same reasoning as assertVisible above.
        throw new NotFoundException({ error: "conversation_not_found" });
      }
    }
    const outcome = await createTicket(this.db, {
      workspaceId,
      conversationId: body.conversationId,
      actor,
      source: actor.apiKeyId ? "api" : "human",
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.priority ? { priority: body.priority } : {}),
      ...(body.assignedUserId !== undefined ? { assignedUserId: body.assignedUserId } : {}),
      ...(body.assignedTeamId !== undefined ? { assignedTeamId: body.assignedTeamId } : {}),
      ...(body.tagIds ? { tagIds: body.tagIds } : {}),
      ...(body.customFields ? { customFields: body.customFields } : {}),
    });
    return this.unwrap(outcome);
  }

  async update(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    body: UpdateTicketInput,
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket; openTicketCount: number }> {
    await this.assertVisible(viewer, id);
    const outcome = await updateTicket(this.db, {
      workspaceId,
      ticketId: id,
      actor,
      ...body,
    });
    return this.unwrap(outcome);
  }

  /**
   * Permanently delete a ticket — a destructive escape hatch for work raised by
   * mistake, distinct from solving/closing (which keep it for reporting).
   *
   * Limited to admins and managers: agents solve or close, they don't destroy
   * the audit trail. Managers/admins are never conversation-visibility-restricted,
   * so no per-conversation viewer check is needed here. The customer's messages
   * survive (SetNull) — only the work item and its timeline go.
   */
  async remove(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    // Session calls pass the workspace role and are gated to admin/manager.
    // API-key calls pass none: `@RequireScope("write:tickets")` is their
    // authorization, and a scoped key is trusted like an integration, not an
    // agent.
    role?: Role,
  ): Promise<{ ok: true }> {
    if (role !== undefined && role !== "admin" && role !== "manager") {
      throw new ForbiddenException({
        error: "forbidden",
        detail:
          "Deleting a ticket is limited to admins and managers. Solve or close it instead.",
      });
    }
    const outcome = await deleteTicket(this.db, { workspaceId, ticketId: id, actor });
    if (!outcome.ok) throw new NotFoundException({ error: "ticket_not_found" });
    return { ok: true };
  }

  /**
   * Append an internal note to a ticket. Never reaches the customer.
   *
   * The receiving half of a handoff: Sales answers "tell them it ships Tuesday"
   * without messaging the customer themselves.
   */
  async addNote(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    body: string,
    viewer?: ConversationViewer,
  ): Promise<{ ok: true }> {
    await this.assertVisible(viewer, id);
    const outcome = await addTicketNote(this.db, {
      workspaceId,
      ticketId: id,
      actor,
      body,
    });
    if (outcome.ok) return { ok: true };
    if (outcome.reason === "empty_note") {
      throw new BadRequestException({ error: "empty_note" });
    }
    throw new NotFoundException({ error: outcome.reason });
  }

  // ---- Saved views ----

  async listViews(workspaceId: string, viewerUserId: string, role: string) {
    return { views: await listTicketViews(this.db, workspaceId, viewerUserId, role) };
  }

  async createView(
    workspaceId: string,
    viewerUserId: string,
    role: string,
    body: CreateTicketViewInput,
  ) {
    const outcome = await createTicketView(this.db, {
      workspaceId,
      viewerUserId,
      role,
      name: body.name,
      ...(body.color ? { color: body.color } : {}),
      ...(body.icon ? { icon: body.icon } : {}),
      visibility: body.visibility,
      filters: body.filters,
    });
    if (outcome.ok) return { view: outcome.view };
    if (outcome.reason === "name_taken") {
      throw new ConflictException({
        error: "name_taken",
        detail: "A view with that name already exists here.",
      });
    }
    throw new NotFoundException({ error: outcome.reason });
  }

  async updateView(
    workspaceId: string,
    viewerUserId: string,
    role: string,
    id: string,
    body: UpdateTicketViewInput,
  ) {
    const outcome = await updateTicketView(this.db, {
      workspaceId,
      viewerUserId,
      role,
      id,
      ...body,
    });
    if (outcome.ok) return { view: outcome.view };
    if (outcome.reason === "name_taken") {
      throw new ConflictException({ error: "name_taken" });
    }
    if (outcome.reason === "forbidden") {
      throw new ForbiddenException({
        error: "forbidden",
        detail:
          "Only the person who created this view — or an admin, for a shared one — can change it.",
      });
    }
    throw new NotFoundException({ error: "view_not_found" });
  }

  async deleteView(workspaceId: string, viewerUserId: string, role: string, id: string) {
    const outcome = await deleteTicketView(this.db, { workspaceId, viewerUserId, role, id });
    if (outcome.ok) return { ok: true as const };
    if (outcome.reason === "forbidden") {
      throw new ForbiddenException({ error: "forbidden" });
    }
    throw new NotFoundException({ error: "view_not_found" });
  }

  // ---- Cross-workspace escalation ----

  /**
   * Where does this ticket id live? Deliberately NOT scoped to the active
   * workspace — that's the point: it recovers a ticket URL opened under the
   * WRONG active workspace (the normal way is following the escalation pair
   * across a switch). The disclosure is bounded twice: the query is scoped to
   * the caller's ORGANIZATION, and the answer is returned only when the
   * caller can actually open that workspace (a membership, or org-wide
   * authority) — same access rule as the workspace switcher itself. 404
   * otherwise, never a hint.
   */
  async locate(
    session: Pick<
      ApiSession,
      "organizationId" | "workspaceId" | "workspaceMemberships" | "orgRole" | "isSuperAdmin"
    >,
    ticketId: string,
  ): Promise<{ workspaceId: string; workspaceName: string; number: number }> {
    const row = await this.db.ticket.findFirst({
      where: { id: ticketId, workspace: { organizationId: session.organizationId } },
      select: { number: true, workspaceId: true, workspace: { select: { name: true } } },
    });
    const canAccess =
      row !== null &&
      (row.workspaceId === session.workspaceId ||
        session.workspaceMemberships.some((m) => m.workspaceId === row.workspaceId) ||
        session.orgRole === "owner" ||
        session.orgRole === "admin" ||
        session.isSuperAdmin);
    if (!row || !canAccess) throw new NotFoundException({ error: "ticket_not_found" });
    return {
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      number: row.number,
    };
  }

  /**
   * The escalation target picker: every OTHER workspace in the caller's org,
   * id + name ONLY. Deliberately not the workspace switcher list — that
   * returns memberships (with roles), and an agent refers a ticket to a
   * workspace they may have no seat in. A sibling workspace's NAME within one
   * organization is not sensitive.
   */
  async listEscalationTargets(workspaceId: string): Promise<{ id: string; name: string }[]> {
    const ws = await this.db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    return this.db.workspace.findMany({
      where: { organizationId: ws.organizationId, id: { not: workspaceId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });
  }

  /**
   * Refer a ticket to a sibling workspace in the organization. Any agent can
   * escalate — same tier as raising a ticket; the visibility boundary applies
   * to the SOURCE ticket like every other write.
   */
  /**
   * Escalate: grant a sibling workspace access to THIS ticket. One ticket, two
   * departments — nothing is copied. Any agent may do it (same tier as raising
   * a ticket), and any workspace that already has access may loop in another.
   */
  async escalate(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    body: EscalateTicketInput,
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket }> {
    await this.assertVisible(viewer, id);
    const outcome = await shareTicket(this.db, {
      workspaceId,
      ticketId: id,
      actor: { ...actor, workspaceId },
      targetWorkspaceId: body.targetWorkspaceId,
      cause: body.cause,
    });
    if (outcome.ok) return { ticket: outcome.ticket };
    switch (outcome.reason) {
      case "already_shared":
        // 409: the STATE refused this, not the input — that workspace already
        // has the key, so a re-read shows it in the participant list.
        throw new ConflictException({
          error: "already_shared",
          detail: "That workspace already has access to this ticket.",
        });
      case "ticket_terminal":
        throw new BadRequestException({ error: "ticket_terminal" });
      case "no_contact":
        throw new BadRequestException({ error: "no_contact" });
      default:
        // ticket_not_found and target_workspace_not_found both 404 — the second
        // deliberately does not confirm what exists outside the caller's org.
        throw new NotFoundException({ error: outcome.reason });
    }
  }

  /** Revoke a workspace's access. Owner-only, or a guest removing itself. */
  async revokeShare(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    guestWorkspaceId: string,
    viewer?: ConversationViewer,
  ): Promise<{ ok: true }> {
    await this.assertVisible(viewer, id);
    const outcome = await revokeTicketShare(this.db, {
      workspaceId,
      ticketId: id,
      guestWorkspaceId,
      actor: { ...actor, workspaceId },
    });
    if (outcome.ok) return { ok: true };
    if (outcome.reason === "forbidden") {
      throw new ForbiddenException({
        error: "forbidden",
        detail:
          "Only the workspace that owns this ticket can remove another workspace's access.",
      });
    }
    throw new NotFoundException({ error: outcome.reason });
  }

  /**
   * Post a message to the ticket's THREAD — the conversation between the
   * departments. Everyone with access to the ticket sees it (an internal
   * `/notes` entry is the other tool: it stays in the workspace that wrote it).
   * Files ride along and are filed against the message so they render with it.
   */
  async postThreadMessage(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    body: string,
    files: UploadedFile[] = [],
    clientTempId?: string,
    viewer?: ConversationViewer,
  ): Promise<{ ok: true; message: TicketThreadMessage }> {
    await this.assertVisible(viewer, id);
    const outcome = await addTicketMessage(this.db, {
      workspaceId,
      ticketId: id,
      actor: { ...actor, workspaceId },
      body,
      ...(clientTempId ? { clientTempId } : {}),
      // Filed BEFORE the realtime frame goes out (see the option's docblock),
      // so every party receives the reply complete with its evidence rather
      // than text now and files on their next reload.
      ...(files.length > 0
        ? { attach: (messageId: string) => this.attachFiles(workspaceId, actor, id, files, messageId) }
        : {}),
    });
    if (!outcome.ok) {
      if (outcome.reason === "empty_message") {
        throw new BadRequestException({ error: "empty_message" });
      }
      throw new NotFoundException({ error: outcome.reason });
    }
    return { ok: true, message: outcome.message };
  }

  /**
   * Clear this reader's unread marker on a ticket's thread.
   *
   * The CALLER decides "genuinely on screen" (§10: a hidden tab must never
   * clear a reply nobody saw).
   *
   * No server frame is emitted. The reading tab clears its own badge with a
   * LOCAL `ticket:thread:read` dispatch — the same discipline the inbox uses
   * for read state ("the list badge clears via a local dispatch, not the
   * one-shot server frame"), and it avoids injecting the realtime emitter into
   * a service that otherwise talks only to the bus. Accepted tradeoff: a second
   * tab keeps its badge until the next frame or reconnect, both of which
   * re-seed from the server.
   */
  async markThreadRead(
    workspaceId: string,
    userId: string,
    id: string,
    viewer?: ConversationViewer,
  ): Promise<{ ok: true }> {
    await this.assertVisible(viewer, id);
    const outcome = await markThreadRead(this.db, { workspaceId, ticketId: id, userId });
    if (!outcome.ok) throw new NotFoundException({ error: outcome.reason });
    return { ok: true };
  }

  /**
   * Attach files to a ticket (at raise time, or to a thread message).
   *
   * Partial success is deliberate and reported: a ticket raised with three
   * screenshots where one is a rejected type must not lose the other two, and
   * must not silently pretend all three landed.
   */
  async attachFiles(
    workspaceId: string,
    actor: TicketActor,
    ticketId: string,
    files: UploadedFile[],
    messageId?: string | null,
  ): Promise<TicketAttachmentView[]> {
    const out: TicketAttachmentView[] = [];
    for (const file of files) {
      const outcome = await addTicketAttachment(this.db, {
        workspaceId,
        ticketId,
        actor: { ...actor, workspaceId },
        ...(messageId ? { messageId } : {}),
        bytes: file.buffer,
        filename: file.originalname,
        mimeType: file.mimetype,
      });
      if (outcome.ok) {
        out.push(outcome.attachment);
        continue;
      }
      if (outcome.reason === "ticket_not_found") {
        throw new NotFoundException({ error: "ticket_not_found" });
      }
      if (outcome.reason === "too_many_attachments") {
        throw new BadRequestException({
          error: "too_many_attachments",
          detail: `A ticket holds at most ${MAX_TICKET_ATTACHMENTS} files.`,
        });
      }
      throw new BadRequestException({
        error: "unsupported_type",
        detail: `${file.originalname} isn't a file type we can store.`,
      });
    }
    return out;
  }

  /** Resolve an attachment's blob key for streaming. Access-gated. */
  async attachmentBlobKey(
    workspaceId: string,
    ticketId: string,
    attachmentId: string,
    viewer?: ConversationViewer,
  ): Promise<{ blobKey: string; filename: string }> {
    await this.assertVisible(viewer, ticketId);
    const found = await getTicketAttachmentForRead(this.db, workspaceId, ticketId, attachmentId);
    if (!found.ok) throw new NotFoundException({ error: "attachment_not_found" });
    return { blobKey: found.blobKey, filename: found.filename };
  }

  async removeAttachment(
    workspaceId: string,
    actor: TicketActor,
    ticketId: string,
    attachmentId: string,
    viewer?: ConversationViewer,
  ): Promise<{ ok: true }> {
    await this.assertVisible(viewer, ticketId);
    const outcome = await removeTicketAttachment(this.db, {
      workspaceId,
      ticketId,
      attachmentId,
      actor: { ...actor, workspaceId },
    });
    if (outcome.ok) return { ok: true };
    if (outcome.reason === "forbidden") {
      throw new ForbiddenException({
        error: "forbidden",
        detail: "Only the workspace that added a file, or the ticket's owner, can remove it.",
      });
    }
    throw new NotFoundException({ error: "attachment_not_found" });
  }

  /**
   * Start THIS workspace's own conversation with the customer on a ticket
   * shared with it, and bind it to the share. Goes through the canonical
   * `startConversation` path (find-or-create contact with stage seeding +
   * soft-delete revive, reopen-not-fragment).
   */
  async messageEscalatedCustomer(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    input: { channelConnectionId?: string },
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket; conversationId: string }> {
    await this.assertVisible(viewer, id);
    const snapshot = await getGuestSnapshot(this.db, workspaceId, id);
    if (!snapshot) {
      // Distinguish "no such ticket" from "you are the OWNER of it" — the owner
      // already has the customer thread in their own inbox.
      const exists = await this.db.ticket.findFirst({
        where: ticketByIdWhere(workspaceId, id),
        select: { id: true },
      });
      if (!exists) throw new NotFoundException({ error: "ticket_not_found" });
      throw new BadRequestException({
        error: "not_a_guest",
        detail: "This ticket is yours — its conversation is already in your inbox.",
      });
    }
    if (!snapshot.phoneNumber) {
      throw new BadRequestException({
        error: "no_phone_in_snapshot",
        detail:
          "The customer's identity on the original channel has no phone number, so this workspace cannot start a chat. Answer with a comment instead.",
      });
    }
    const started = await this.conversations.startConversation(workspaceId, actor.userId ?? null, {
      phone: snapshot.phoneNumber,
      ...(snapshot.name ? { name: snapshot.name } : {}),
      ...(input.channelConnectionId ? { channelConnectionId: input.channelConnectionId } : {}),
    });
    const outcome = await bindGuestConversation(this.db, {
      workspaceId,
      ticketId: id,
      actor: { ...actor, workspaceId },
      conversationId: started.conversationId,
    });
    if (outcome.ok) return { ticket: outcome.ticket, conversationId: started.conversationId };
    if (outcome.reason === "already_bound") {
      // A double-click raced us — the thread exists and the share is bound;
      // hand back the current state instead of an error.
      const ticket = await getTicket(this.db, workspaceId, id);
      if (ticket?.conversationId) {
        return { ticket, conversationId: ticket.conversationId };
      }
      throw new ConflictException({ error: "already_bound" });
    }
    if (outcome.reason === "conversation_not_found") {
      throw new NotFoundException({ error: "conversation_not_found" });
    }
    if (outcome.reason === "not_a_guest") {
      throw new BadRequestException({ error: "not_a_guest" });
    }
    throw new NotFoundException({ error: "ticket_not_found" });
  }

  /** Map the domain's typed outcome onto HTTP. The domain never throws. */
  private unwrap(outcome: TicketOutcome): { ticket: Ticket; openTicketCount: number } {
    if (outcome.ok) return { ticket: outcome.ticket, openTicketCount: outcome.openTicketCount };
    switch (outcome.reason) {
      case "version_conflict":
        // 409 so a board drag can re-read and retry, rather than a 400 the UI
        // would surface as "your input was wrong" — it wasn't, it was stale.
        throw new ConflictException({ error: "version_conflict" });
      case "assignee_not_found":
        throw new BadRequestException({ error: "assignee_not_found" });
      case "team_not_found":
        // 400, not 404: the TICKET was found — the team id the caller supplied
        // is the bad input. A 404 here would read as "no such ticket" and send
        // the caller looking in the wrong place.
        throw new BadRequestException({ error: "team_not_found" });
      case "ticket_terminal":
        throw new BadRequestException({ error: "ticket_terminal" });
      case "cause_immutable":
        throw new BadRequestException({
          error: "cause_immutable",
          detail:
            "The cause is written once, when the ticket is raised. Add a note or a shared comment instead of rewriting it.",
        });
      default:
        throw new NotFoundException({ error: outcome.reason });
    }
  }

  // ---- Settings: SLA policies ----

  async listSlaPolicies(workspaceId: string): Promise<TicketSlaPolicy[]> {
    const rows = await this.db.ticketSlaPolicy.findMany({
      where: { workspaceId },
      orderBy: { priority: "asc" },
      select: {
        id: true,
        priority: true,
        firstResponseMins: true,
        resolutionMins: true,
        pauseOnHold: true,
        pauseWhenPending: true,
        businessHoursOnly: true,
        isActive: true,
      },
    });
    return rows;
  }

  /**
   * One policy per priority, so this is an upsert on that natural key rather
   * than a create/update pair — an admin editing "urgent" twice must not end up
   * with two urgent policies racing to apply.
   */
  async upsertSlaPolicy(
    workspaceId: string,
    body: UpsertSlaPolicyInput,
  ): Promise<TicketSlaPolicy> {
    const data = {
      firstResponseMins: body.firstResponseMins,
      resolutionMins: body.resolutionMins,
      ...(body.pauseOnHold !== undefined ? { pauseOnHold: body.pauseOnHold } : {}),
      ...(body.pauseWhenPending !== undefined ? { pauseWhenPending: body.pauseWhenPending } : {}),
      ...(body.businessHoursOnly !== undefined
        ? { businessHoursOnly: body.businessHoursOnly }
        : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    };
    const row = await this.db.ticketSlaPolicy.upsert({
      where: { workspaceId_priority: { workspaceId, priority: body.priority } },
      create: { workspaceId, priority: body.priority, ...data },
      update: data,
      select: {
        id: true,
        priority: true,
        firstResponseMins: true,
        resolutionMins: true,
        pauseOnHold: true,
        pauseWhenPending: true,
        businessHoursOnly: true,
        isActive: true,
      },
    });
    return row;
  }

  // ---- Settings: custom fields ----

  async listFields(workspaceId: string): Promise<TicketFieldDefinition[]> {
    return this.db.ticketFieldDefinition.findMany({
      where: { workspaceId },
      orderBy: [{ order: "asc" }, { label: "asc" }],
      select: { id: true, key: true, label: true, order: true, isVisible: true },
    });
  }

  async createField(
    workspaceId: string,
    body: CreateTicketFieldInput,
  ): Promise<TicketFieldDefinition> {
    // The key is derived once and then IMMUTABLE — `Ticket.customFields` is
    // keyed by it, so a rename that changed the key would orphan every stored
    // value. Same rule as ContactFieldDefinition.
    const key = body.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
    if (!key) throw new BadRequestException({ error: "invalid_label" });
    const existing = await this.db.ticketFieldDefinition.findUnique({
      where: { workspaceId_key: { workspaceId, key } },
      select: { id: true },
    });
    if (existing) throw new ConflictException({ error: "field_exists" });
    return this.db.ticketFieldDefinition.create({
      data: { workspaceId, key, label: body.label, order: body.order ?? 0 },
      select: { id: true, key: true, label: true, order: true, isVisible: true },
    });
  }

  async updateField(
    workspaceId: string,
    id: string,
    body: UpdateTicketFieldInput,
  ): Promise<TicketFieldDefinition> {
    const res = await this.db.ticketFieldDefinition.updateMany({
      where: { id, workspaceId },
      data: body,
    });
    if (res.count === 0) throw new NotFoundException({ error: "field_not_found" });
    return this.db.ticketFieldDefinition.findUniqueOrThrow({
      where: { id },
      select: { id: true, key: true, label: true, order: true, isVisible: true },
    });
  }

  /**
   * Delete a field definition. The stored VALUES in `Ticket.customFields` are
   * left alone: they are history on closed work, and rewriting a JSONB column
   * across every ticket in the workspace to tidy up a settings change is both
   * expensive and destructive. The values simply stop rendering.
   */
  async deleteField(workspaceId: string, id: string): Promise<void> {
    const res = await this.db.ticketFieldDefinition.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException({ error: "field_not_found" });
  }

  // ---- Settings: workspace-level ticket behaviour ----

  async getSettings(workspaceId: string): Promise<TicketSettingsInput> {
    const ws = await this.db.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: {
        ticketReopenWindowHours: true,
        ticketCloseConversationOnLastSolved: true,
      },
    });
    return ws;
  }

  async updateSettings(
    workspaceId: string,
    body: TicketSettingsInput,
  ): Promise<TicketSettingsInput> {
    const ws = await this.db.workspace.update({
      where: { id: workspaceId },
      data: body,
      select: {
        ticketReopenWindowHours: true,
        ticketCloseConversationOnLastSolved: true,
      },
    });
    return ws;
  }
}
