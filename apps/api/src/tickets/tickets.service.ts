import {
  BadRequestException,
  ConflictException,
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
import { isRestrictedViewer, type ConversationViewer } from "@/lib/conversations/visibility";
import {
  addTicketNote,
  createTicket,
  updateTicket,
  type TicketActor,
  type TicketOutcome,
} from "@/lib/tickets/mutations";
import {
  getTicket,
  getTicketCounts,
  listTicketEvents,
  listTickets,
} from "@/lib/tickets/queries";

import { DbService } from "../db/db.service";
import type {
  CreateTicketFieldInput,
  CreateTicketInput,
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
  constructor(private readonly db: DbService) {}

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
    return { conversation: { assignedUserId: viewer.userId } } as const;
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
  ): Promise<{ ticket: Ticket; openTicketCount: number }> {
    const outcome = await createTicket(this.db, {
      workspaceId,
      conversationId: body.conversationId,
      actor,
      source: actor.apiKeyId ? "api" : "human",
      ...(body.subject !== undefined ? { subject: body.subject } : {}),
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
        ticketAutoOpen: true,
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
        ticketAutoOpen: true,
        ticketReopenWindowHours: true,
        ticketCloseConversationOnLastSolved: true,
      },
    });
    return ws;
  }
}
