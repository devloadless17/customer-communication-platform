import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import type {
  Ticket,
  TicketCounts,
  TicketEvent,
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
  addEscalationComment,
  bindEscalatedTicketConversation,
  escalateTicket,
  getEscalationSnapshot,
} from "@/lib/tickets/escalations";
import type { Role } from "@ccp/shared/types";
import {
  getTicket,
  getTicketCounts,
  listTicketEvents,
  listTickets,
  ticketVisibilityWhere,
} from "@/lib/tickets/queries";

import type { ApiSession } from "../auth/session.guard";
import { ConversationsService } from "../conversations/conversations.service";
import { DbService } from "../db/db.service";
import type {
  CreateTicketFieldInput,
  CreateTicketInput,
  EscalateTicketInput,
  ListTicketsQuery,
  TicketSettingsInput,
  UpdateTicketFieldInput,
  UpdateTicketInput,
  UpsertSlaPolicyInput,
} from "./tickets.schemas";

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
      where: { AND: [{ id: ticketId, workspaceId: viewer!.workspaceId }, restriction] },
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
  ): Promise<{ tickets: Ticket[]; nextCursor: { createdAt: string; id: string } | null }> {
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

    return listTickets(this.db, workspaceId, {
      ...this.filters(query),
      ...(assignedUserId !== undefined ? { assignedUserId } : {}),
      ...(assignedTeamId !== undefined ? { assignedTeamId } : {}),
      ...(restrictedTo ? { restrictToConversationsAssignedTo: restrictedTo } : {}),
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
      ...(query.cursorCreatedAt && query.cursorId
        ? { cursor: { createdAt: new Date(query.cursorCreatedAt), id: query.cursorId } }
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

  async get(
    workspaceId: string,
    id: string,
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket; events: TicketEvent[] }> {
    await this.assertVisible(viewer, id);
    const ticket = await getTicket(this.db, workspaceId, id);
    if (!ticket) throw new NotFoundException({ error: "ticket_not_found" });
    const events = await listTicketEvents(this.db, workspaceId, id);
    return { ticket, events };
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
  async escalate(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    body: EscalateTicketInput,
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket }> {
    await this.assertVisible(viewer, id);
    const outcome = await escalateTicket(this.db, {
      workspaceId,
      ticketId: id,
      actor,
      targetWorkspaceId: body.targetWorkspaceId,
      cause: body.cause,
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
    });
    if (outcome.ok) return { ticket: outcome.sourceTicket };
    switch (outcome.reason) {
      case "already_escalated":
        // 409: the state, not the input, is what refused this — a concurrent
        // escalate may have just landed, so a re-read shows the existing link.
        throw new ConflictException({ error: "already_escalated" });
      case "cannot_escalate_escalated_ticket":
        throw new BadRequestException({
          error: "cannot_escalate_escalated_ticket",
          detail:
            "This ticket IS an escalation — answer it here or on its source; chains are not allowed.",
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

  /** Post a comment BOTH sides of the escalation pair see. */
  async addEscalationComment(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    body: string,
    viewer?: ConversationViewer,
  ): Promise<{ ok: true }> {
    await this.assertVisible(viewer, id);
    const outcome = await addEscalationComment(this.db, {
      workspaceId,
      ticketId: id,
      actor,
      body,
    });
    if (outcome.ok) return { ok: true };
    switch (outcome.reason) {
      case "empty_comment":
        throw new BadRequestException({ error: "empty_comment" });
      case "not_escalated":
        throw new BadRequestException({ error: "not_escalated" });
      case "escalation_severed":
        throw new BadRequestException({
          error: "escalation_severed",
          detail: "The linked ticket was deleted — there is nobody on the other end.",
        });
      default:
        throw new NotFoundException({ error: outcome.reason });
    }
  }

  /**
   * Start this workspace's OWN conversation with the escalated customer, from
   * the snapshot's phone, and bind it to the ticket. Goes through the canonical
   * `startConversation` path (find-or-create contact with stage seeding +
   * soft-delete revive, reopen-not-fragment) — from then on the ticket is a
   * completely normal ticket.
   */
  async messageEscalatedCustomer(
    workspaceId: string,
    actor: TicketActor,
    id: string,
    input: { channelConnectionId?: string },
    viewer?: ConversationViewer,
  ): Promise<{ ticket: Ticket; conversationId: string }> {
    await this.assertVisible(viewer, id);
    const snapshot = await getEscalationSnapshot(this.db, workspaceId, id);
    if (!snapshot) {
      // Distinguish "no such ticket" from "not an escalated-in ticket".
      const exists = await this.db.ticket.findFirst({
        where: { id, workspaceId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException({ error: "ticket_not_found" });
      throw new BadRequestException({ error: "not_escalated_in" });
    }
    if (!snapshot.phoneNumber) {
      throw new BadRequestException({
        error: "no_phone_in_snapshot",
        detail:
          "The customer's identity on the source channel has no phone number, so this workspace cannot start a chat. Answer through the shared comments instead.",
      });
    }
    const started = await this.conversations.startConversation(workspaceId, actor.userId ?? null, {
      phone: snapshot.phoneNumber,
      ...(snapshot.name ? { name: snapshot.name } : {}),
      ...(input.channelConnectionId ? { channelConnectionId: input.channelConnectionId } : {}),
    });
    const outcome = await bindEscalatedTicketConversation(this.db, {
      workspaceId,
      ticketId: id,
      actor,
      conversationId: started.conversationId,
    });
    if (outcome.ok) return { ticket: outcome.ticket, conversationId: started.conversationId };
    if (outcome.reason === "already_bound") {
      // A double-click raced us — the conversation exists and the ticket is
      // bound; hand back the current state instead of an error.
      const ticket = await getTicket(this.db, workspaceId, id);
      if (ticket?.conversationId) {
        return { ticket, conversationId: ticket.conversationId };
      }
      throw new ConflictException({ error: "already_bound" });
    }
    if (outcome.reason === "conversation_not_found") {
      throw new NotFoundException({ error: "conversation_not_found" });
    }
    if (outcome.reason === "not_escalated_in") {
      throw new BadRequestException({ error: "not_escalated_in" });
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
